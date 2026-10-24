import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolves symlinks for the longest existing prefix of `p`, then re-appends the
 * non-existing remainder. Needed because Seatbelt matches real paths
 * (e.g. /tmp -> /private/tmp) and because cwd checks must not be fooled by links.
 */
export function realpathLoose(p: string): string {
  const abs = resolve(expandHome(p));
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
}

export function isWithin(child: string, parent: string): boolean {
  const c = child.endsWith(sep) ? child : child + sep;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return c.startsWith(p);
}

export function ensureDir(p: string, mode = 0o700): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true, mode });
  return p;
}

export function defaultStateDir(): string {
  return process.env.MCP_TERMINAL_STATE_DIR
    ? resolve(expandHome(process.env.MCP_TERMINAL_STATE_DIR))
    : join(homedir(), '.local', 'state', 'mcp-terminal');
}

export function defaultConfigDir(): string {
  return process.env.MCP_TERMINAL_CONFIG_DIR
    ? resolve(expandHome(process.env.MCP_TERMINAL_CONFIG_DIR))
    : join(homedir(), '.config', 'mcp-terminal');
}

const confCache = new Map<string, string>();
function getconf(name: string): string | undefined {
  if (!confCache.has(name)) {
    let v = '';
    try {
      v = execFileSync('/usr/bin/getconf', [name], { encoding: 'utf8' }).trim();
    } catch {
      v = '';
    }
    confCache.set(name, v);
  }
  return confCache.get(name) || undefined;
}
export function darwinUserCacheDir(): string | undefined {
  return getconf('DARWIN_USER_CACHE_DIR');
}
/**
 * The per-user temp dir (/var/folders/…/T/). GUI-launched clients often do not pass
 * TMPDIR, but Apple tooling (NSTemporaryDirectory, clang/swift caches) still uses it.
 */
export function darwinUserTempDir(): string | undefined {
  return getconf('DARWIN_USER_TEMP_DIR');
}
/** TMPDIR if set, else the per-user temp dir, else os.tmpdir(). */
export function userTempDir(): string {
  return process.env.TMPDIR || darwinUserTempDir() || tmpdir();
}

export interface PathVars {
  cwd?: string;
}

/** Expands `~`, `{cwd}`, `{tmpdir}`, `{home}` and `{darwin_cache}` placeholders. */
export function expandPathTemplate(p: string, vars: PathVars): string | undefined {
  let out = p;
  if (out.includes('{cwd}')) {
    if (!vars.cwd) return undefined;
    out = out.replaceAll('{cwd}', vars.cwd);
  }
  if (out.includes('{darwin_cache}')) {
    const d = darwinUserCacheDir();
    if (!d) return undefined;
    out = out.replaceAll('{darwin_cache}', d);
  }
  out = out.replaceAll('{tmpdir}', userTempDir()).replaceAll('{home}', homedir());
  out = expandHome(out);
  if (!isAbsolute(out)) return undefined;
  return realpathLoose(out);
}
