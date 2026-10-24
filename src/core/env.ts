import { userTempDir } from '../util/paths.js';
import { spawn } from 'node:child_process';
import type { Config } from '../config/schema.js';
import type { Redactor } from '../output/redactor.js';
import { log } from '../util/log.js';

export function globToRegExp(glob: string, flags = 'i'): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, flags);
}

const BEGIN = '__MCPT_ENV_BEGIN__';
const END = '__MCPT_ENV_END__';

/** Runs `$SHELL -l -i -c 'env -0'` once to recover the user's terminal environment. */
export function resolveLoginEnv(shell: string, timeoutMs = 10_000): Promise<Record<string, string> | undefined> {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let done = false;
    const finish = (v: Record<string, string> | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(shell, ['-l', '-i', '-c', `printf ${BEGIN}; command env -0; printf ${END}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, MCP_TERMINAL_RESOLVING_ENV: '1' },
        detached: true,
      });
    } catch {
      return finish(undefined);
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* ignore */
      }
      log.warn(`login environment resolution timed out after ${timeoutMs}ms; using the server environment`);
      finish(undefined);
    }, timeoutMs);
    child.stdout!.on('data', (b: Buffer) => {
      if (out.length < 4 * 1024 * 1024) out = Buffer.concat([out, b]);
    });
    child.once('error', () => finish(undefined));
    child.once('close', () => {
      const s = out.toString('utf8');
      const a = s.indexOf(BEGIN);
      const b = s.lastIndexOf(END);
      if (a < 0 || b < a) return finish(undefined);
      const env: Record<string, string> = {};
      for (const entry of s.slice(a + BEGIN.length, b).split('\0')) {
        const eq = entry.indexOf('=');
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      finish(env);
    });
  });
}

// Variables that describe the server's own process or the client's terminal and
// must not leak into sessions.
const NEVER_INHERIT = new Set(['SHLVL', 'PWD', 'OLDPWD', '_', 'TERM_SESSION_ID', 'ZDOTDIR', 'MCP_TERMINAL_RESOLVING_ENV', 'ITERM_SESSION_ID']);

export class EnvBuilder {
  private loginEnv: Record<string, string> | undefined;
  private ready: Promise<void> = Promise.resolve();
  private allow: RegExp[];
  private deny: RegExp[];

  constructor(
    private cfg: Config,
    private redactor: Redactor,
    private shell: string,
  ) {
    this.allow = cfg.security.env.allowlist.map((g) => globToRegExp(g, ''));
    this.deny = cfg.security.env.deny_patterns.map((g) => globToRegExp(g));
  }

  init() {
    if (this.cfg.shell.resolve_login_env && !process.env.MCP_TERMINAL_RESOLVING_ENV) {
      const t0 = Date.now();
      this.ready = resolveLoginEnv(this.shell).then((env) => {
        this.loginEnv = env;
        if (env) log.debug(`resolved login environment in ${Date.now() - t0}ms (${Object.keys(env).length} vars)`);
      });
    }
    return this.ready;
  }

  whenReady(maxMs = 10_000) {
    return Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, maxMs).unref())]);
  }

  isDenied(name: string) {
    return this.deny.some((re) => re.test(name));
  }

  /** Names of variables that would be stripped from the inherited environment. */
  strippedNames(): string[] {
    return Object.keys(this.base()).filter((k) => this.isDenied(k));
  }

  private base(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (this.loginEnv) Object.assign(env, this.loginEnv);
    return env;
  }

  build(extra: Record<string, string> = {}, sessionId?: string): Record<string, string> {
    const src = this.base();
    const out: Record<string, string> = {};
    const mode = this.cfg.security.env.inherit;
    for (const [k, v] of Object.entries(src)) {
      if (NEVER_INHERIT.has(k)) continue;
      if (this.isDenied(k)) {
        this.redactor.addLiteral(v);
        continue;
      }
      if (mode === 'allowlist' && !this.allow.some((re) => re.test(k))) continue;
      out[k] = v;
    }
    Object.assign(out, this.cfg.security.env.set);
    for (const [k, v] of Object.entries(extra)) {
      if (this.isDenied(k)) this.redactor.addLiteral(v);
      out[k] = v;
    }
    out.TERM = 'xterm-256color';
    out.COLORTERM = out.COLORTERM ?? 'truecolor';
    if (!out.LANG && !out.LC_ALL && !out.LC_CTYPE) out.LANG = 'en_US.UTF-8';
    if (!out.TMPDIR) out.TMPDIR = userTempDir();
    out.PAGER = extra.PAGER ?? 'cat';
    out.GIT_PAGER = extra.GIT_PAGER ?? 'cat';
    out.MCP_TERMINAL = '1';
    if (sessionId) out.MCP_TERMINAL_SESSION_ID = sessionId;
    if (!out.PATH) out.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    return out;
  }
}
