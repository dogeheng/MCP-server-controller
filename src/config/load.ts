import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ConfigSchema, RuleSchema, type Config, type Rule } from './schema.js';
import { defaultConfigDir, defaultStateDir, expandHome } from '../util/paths.js';

export interface CliOverrides {
  configPath?: string;
  profile?: 'workspace' | 'host';
  network?: 'allow' | 'localhost' | 'deny';
  allowWrite?: string[];
  denyRead?: string[];
  roots?: string[];
  defaultCwd?: string;
  /** Shortcut: confine sessions to this directory (roots = [dir], default cwd = dir). */
  workspace?: string;
  defaultWaitMs?: number;
  approval?: 'auto' | 'elicit' | 'dialog' | 'cli' | 'deny';
  stateDir?: string;
  projectConfig?: boolean;
}

export interface LoadedConfig {
  config: Config;
  configDir: string;
  stateDir: string;
  sources: string[];
  warnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  }
  return out;
}

function readToml(path: string): Obj {
  return parseToml(readFileSync(path, 'utf8')) as Obj;
}

const splitList = (v: string | undefined) => (v ? v.split(':').map((s) => s.trim()).filter(Boolean) : []);

export function loadConfig(cli: CliOverrides = {}): LoadedConfig {
  const configDir = defaultConfigDir();
  const sources: string[] = [];
  const warnings: string[] = [];
  let raw: Obj = {};

  const userFile = join(configDir, 'config.toml');
  if (existsSync(userFile)) {
    raw = deepMerge(raw, readToml(userFile));
    sources.push(userFile);
  }
  const explicit = cli.configPath ?? process.env.MCP_TERMINAL_CONFIG;
  if (explicit) {
    const p = resolve(expandHome(explicit));
    if (!existsSync(p)) throw new Error(`config file not found: ${p}`);
    raw = deepMerge(raw, readToml(p));
    sources.push(p);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const cfg = parsed.data;

  // Environment variable overrides (useful in MCP client "env" blocks).
  const env = process.env;
  const profile = cli.profile ?? (env.MCP_TERMINAL_PROFILE as Config['security']['profile'] | undefined);
  if (profile) cfg.security.profile = profile;
  const network = cli.network ?? (env.MCP_TERMINAL_NETWORK as Config['security']['sandbox']['network'] | undefined);
  if (network) cfg.security.sandbox.network = network;
  cfg.security.sandbox.allow_write.push(...splitList(env.MCP_TERMINAL_ALLOW_WRITE), ...(cli.allowWrite ?? []));
  cfg.security.sandbox.deny_read.push(...splitList(env.MCP_TERMINAL_DENY_READ), ...(cli.denyRead ?? []));
  // Explicit roots replace the configured ones (so --root really confines sessions).
  const workspace = cli.workspace ?? env.MCP_TERMINAL_WORKSPACE;
  const roots = [...(workspace ? [workspace] : []), ...splitList(env.MCP_TERMINAL_ROOTS), ...(cli.roots ?? [])];
  if (roots.length) cfg.security.allowed_roots = roots;
  const defaultCwd = cli.defaultCwd ?? env.MCP_TERMINAL_DEFAULT_CWD ?? workspace;
  if (defaultCwd) cfg.security.default_cwd = defaultCwd;
  const wait = cli.defaultWaitMs ?? (env.MCP_TERMINAL_DEFAULT_WAIT_MS ? Number(env.MCP_TERMINAL_DEFAULT_WAIT_MS) : undefined);
  if (wait !== undefined && Number.isFinite(wait)) cfg.limits.default_wait_ms = Math.max(0, Math.min(wait, cfg.limits.max_wait_ms));
  const approval = cli.approval ?? (env.MCP_TERMINAL_APPROVAL as Config['security']['approval']['mode'] | undefined);
  if (approval) cfg.security.approval.mode = approval;

  // Rules persisted by `termctl approve --always`.
  const approvedFile = join(configDir, 'approved-rules.toml');
  if (existsSync(approvedFile)) {
    try {
      const doc = readToml(approvedFile);
      const rules = Array.isArray(doc.rules) ? doc.rules : [];
      for (const r of rules) {
        const ok = RuleSchema.safeParse(r);
        if (ok.success) cfg.security.rules.push(ok.data);
      }
      sources.push(approvedFile);
    } catch (e) {
      warnings.push(`ignored ${approvedFile}: ${(e as Error).message}`);
    }
  }

  // Project-level config may only tighten security.
  if (cli.projectConfig !== false) {
    const projectDir = cfg.security.default_cwd ? resolve(expandHome(cfg.security.default_cwd)) : process.cwd();
    const projectFile = join(projectDir, '.mcp-terminal.toml');
    if (existsSync(projectFile)) {
      try {
        applyTightenOnly(cfg, readToml(projectFile), warnings);
        sources.push(`${projectFile} (tighten-only)`);
      } catch (e) {
        warnings.push(`ignored ${projectFile}: ${(e as Error).message}`);
      }
    }
  }

  const stateDir = resolve(expandHome(cli.stateDir ?? cfg.state_dir ?? defaultStateDir()));
  return { config: cfg, configDir, stateDir, sources, warnings };
}

const NET_ORDER = { allow: 0, localhost: 1, deny: 2 } as const;

function applyTightenOnly(cfg: Config, doc: Obj, warnings: string[]) {
  const sec = isObj(doc.security) ? doc.security : {};
  if (sec.profile === 'workspace') cfg.security.profile = 'workspace';
  else if (sec.profile !== undefined) warnings.push('project config cannot relax security.profile');
  if (Array.isArray(sec.rules)) {
    for (const r of sec.rules) {
      const ok = RuleSchema.safeParse(r);
      if (!ok.success) continue;
      if (ok.data.decision === 'allow') {
        warnings.push(`project config cannot add allow rules (${ok.data.match.join(', ')})`);
        continue;
      }
      cfg.security.rules.push(ok.data as Rule);
    }
  }
  const sb = isObj(sec.sandbox) ? sec.sandbox : {};
  if (Array.isArray(sb.deny_read)) cfg.security.sandbox.deny_read.push(...sb.deny_read.map(String));
  if (typeof sb.network === 'string' && sb.network in NET_ORDER) {
    const want = sb.network as keyof typeof NET_ORDER;
    if (NET_ORDER[want] > NET_ORDER[cfg.security.sandbox.network]) cfg.security.sandbox.network = want;
  }
  if (sb.allow_write !== undefined) warnings.push('project config cannot add writable directories');
  const env = isObj(sec.env) ? sec.env : {};
  if (Array.isArray(env.deny_patterns)) cfg.security.env.deny_patterns.push(...env.deny_patterns.map(String));
}
