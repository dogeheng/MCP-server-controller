import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import type { LoadedConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { EnvBuilder } from './core/env.js';
import { SessionManager } from './core/manager.js';
import { Guard } from './mcp/guard.js';
import { setTextFormat } from './mcp/render.js';
import { registerTools } from './mcp/tools.js';
import { Redactor } from './output/redactor.js';
import { ApprovalStore } from './policy/approvals.js';
import { PolicyEngine } from './policy/engine.js';
import { initParser } from './policy/parser.js';
import { resolveSandbox } from './sandbox/seatbelt.js';
import { AuditLog } from './store/audit.js';
import { Registry } from './store/registry.js';
import { newInstanceId } from './util/ids.js';
import { log } from './util/log.js';
import { ensureDir, expandHome, realpathLoose } from './util/paths.js';
import { processStartTime } from './util/proc.js';

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

export interface Runtime {
  cfg: Config;
  configDir: string;
  stateDir: string;
  instanceId: string;
  registry: Registry;
  audit: AuditLog;
  redactor: Redactor;
  env: EnvBuilder;
  mgr: SessionManager;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  shell: string;
  clientCaps?: () => Record<string, unknown> | undefined;
}

export function userShell(cfg: Config): string {
  return cfg.shell.program ? expandHome(cfg.shell.program) : process.env.SHELL || '/bin/zsh';
}

export async function createRuntime(loaded: LoadedConfig): Promise<Runtime> {
  const { config: cfg, configDir, stateDir } = loaded;
  ensureDir(stateDir);
  const instanceId = newInstanceId();
  const registry = new Registry(stateDir);
  const audit = new AuditLog(cfg.audit.path ? expandHome(cfg.audit.path) : join(stateDir, 'audit'), instanceId, cfg.audit.enabled);
  const redactor = new Redactor(cfg.security.redact.enabled, cfg.security.redact.secrets, cfg.security.redact.patterns);
  const shell = userShell(cfg);
  const env = new EnvBuilder(cfg, redactor, shell);
  void env.init();
  await initParser();
  registry.addInstance({ id: instanceId, pid: process.pid, pid_start: (await processStartTime(process.pid)) ?? null, started_at: Date.now(), client: null });
  const mgr = new SessionManager({ cfg, stateDir, configDir, instanceId, registry, audit, redactor, env, shell });
  await mgr.init();
  const approvals = new ApprovalStore(stateDir);
  approvals.prune();
  const policy = new PolicyEngine(cfg);
  setTextFormat(cfg.output.text_format);
  audit.write({
    event: 'server_start',
    version: VERSION,
    pid: process.pid,
    profile: cfg.security.profile,
    network: cfg.security.sandbox.network,
    roots: cfg.security.allowed_roots,
    approval: cfg.security.approval.mode,
    config_sources: loaded.sources,
  });
  for (const w of loaded.warnings) log.warn(w);
  return { cfg, configDir, stateDir, instanceId, registry, audit, redactor, env, mgr, policy, approvals, shell };
}

export function instructions(rt: Runtime): string {
  const cfg = rt.cfg;
  const sb = cfg.security;
  let sandboxLine: string;
  if (sb.profile === 'workspace') {
    let writable = '';
    try {
      writable = resolveSandbox(rt.mgr.sandboxSpec(), rt.mgr.defaultCwd()).writable.join(', ');
    } catch {
      writable = sb.sandbox.allow_write.join(', ');
    }
    sandboxLine =
      `Sandbox (macOS Seatbelt): processes can read most files but write only inside the session cwd and: ${writable}. ` +
      `Network: ${sb.sandbox.network}. Credential dirs (~/.ssh, ~/.aws, …) are unreadable. "Operation not permitted" errors usually mean the sandbox blocked a write — work inside the session cwd.`;
  } else sandboxLine = 'No OS sandbox (host profile): commands run with the user\'s permissions.';
  const roots = sb.allowed_roots.map((r) => realpathLoose(expandHome(r))).join(', ');
  return [
    'Local terminal sessions on the user\'s Mac.',
    'Workflow: one-off command → terminal_run. Multi-step work, interactive programs, servers → terminal_create (shell) → terminal_exec per command (returns that command\'s output + exit code) → terminal_read to follow long tasks → terminal_close when done.',
    'Output is addressed by byte cursors; omit cursor to continue from the last read, nothing is lost while you are not reading. Use until=["pattern:<regex>"] / ["command_done"] / ["exit"] / ["input"] to block until something happens instead of polling.',
    'Interactive input: terminal_send(text, submit=true) answers prompts; keys=["C-c"] interrupts; view="screen" shows full-screen apps (vim, top). status "awaiting_input" means the program waits for you.',
    'Background jobs: start long-running servers in their own session (terminal_create program=… or a dedicated shell) and wait for a readiness line with terminal_read(until=["pattern:listening|ready"]).',
    `Working directories must be inside: ${roots}. Default cwd: ${rt.mgr.defaultCwd()}.`,
    sandboxLine,
    'Some commands (sudo, rm -rf, curl|sh, git push --force, …) are blocked or need the user\'s approval. On APPROVAL_REQUIRED follow the hint (ask the user, then retry with approval_id); never try to bypass a POLICY_DENIED.',
  ].join('\n');
}

export function buildServer(rt: Runtime): McpServer {
  let server: McpServer;
  const guard = new Guard(rt.cfg, rt.configDir, rt.policy, rt.approvals, rt.audit, () => server?.server.getClientCapabilities() as Record<string, unknown> | undefined);
  server = new McpServer(
    { name: 'mcp-terminal', title: 'Terminal Controller', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: instructions(rt),
      requestState: { verify: guard.codec.verify },
    },
  );
  registerTools(server, { mgr: rt.mgr, guard, redactor: rt.redactor, cfg: rt.cfg, audit: rt.audit });
  const inner = server.server as unknown as {
    oninitialized?: () => void;
    getClientVersion(): { name?: string; version?: string } | undefined;
    getClientCapabilities?(): Record<string, unknown> | undefined;
  };
  inner.oninitialized = () => {
    const c = inner.getClientVersion();
    if (c) {
      const label = `${c.name ?? '?'} ${c.version ?? ''}`.trim();
      rt.registry.setInstanceClient(rt.instanceId, label);
      const caps = Object.keys(inner.getClientCapabilities?.() ?? {});
      rt.audit.write({ event: 'client_connected', client: label, capabilities: caps });
      log.info(`client connected: ${label}`);
    }
  };
  return server;
}

export async function shutdownRuntime(rt: Runtime, reason: string) {
  log.info(`shutting down (${reason})`);
  try {
    await rt.mgr.shutdown();
  } catch (e) {
    log.warn('error while terminating sessions', e);
  }
  rt.audit.write({ event: 'server_stop', reason });
  try {
    rt.registry.removeInstance(rt.instanceId);
  } catch {
    /* ignore */
  }
  rt.registry.close();
}
