import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { PipeBackend } from '../backends/pipe.js';
import { PtyBackend } from '../backends/pty.js';
import { resolveExecutable, type Backend } from '../backends/types.js';
import { prepareShell } from '../detect/shell.js';
import type { Redactor } from '../output/redactor.js';
import { resolveSandbox, sandboxAvailable, wrapArgv, writeProfile, type SandboxSpec } from '../sandbox/seatbelt.js';
import type { AuditLog } from '../store/audit.js';
import type { Registry, SessionRow } from '../store/registry.js';
import { newNonce, newSessionId } from '../util/ids.js';
import { log } from '../util/log.js';
import { darwinUserCacheDir, ensureDir, expandHome, isWithin, realpathLoose } from '../util/paths.js';
import {
  descendants,
  groupAlive,
  isAlive,
  listAllProcesses,
  processStartTime,
  signalGroup,
  signalPid,
  sleep,
} from '../util/proc.js';
import type { EnvBuilder } from './env.js';
import { TerminalError } from './errors.js';
import { Session, type Integration, type SessionKind, type SessionMode } from './session.js';

export interface ManagerDeps {
  cfg: Config;
  stateDir: string;
  configDir: string;
  instanceId: string;
  registry: Registry;
  audit: AuditLog;
  redactor: Redactor;
  env: EnvBuilder;
  shell: string;
}

export interface CreateOptions {
  kind: SessionKind;
  mode: SessionMode;
  program?: string;
  args?: string[];
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
  cols?: number;
  rows?: number;
  sandbox?: 'workspace' | 'host';
  idleTtlS?: number;
  stdin?: string;
  keepStdinOpen?: boolean;
}

export interface TerminateResult {
  signals: string[];
  killed_groups: number[];
  leftover: number[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private trackTimer: NodeJS.Timeout | undefined;
  private trackChain: Promise<void> = Promise.resolve();
  private trackQueued = 0;
  private ownPgid = process.pid;
  private closing = false;

  constructor(readonly d: ManagerDeps) {}

  get cfg() {
    return this.d.cfg;
  }

  async init() {
    try {
      const all = await listAllProcesses();
      this.ownPgid = all.find((p) => p.pid === process.pid)?.pgid ?? process.pid;
    } catch {
      /* ignore */
    }
    await this.reconcile();
    this.sweepTimer = setInterval(() => void this.sweep(), 30_000);
    this.sweepTimer.unref();
    this.trackTimer = setInterval(() => void this.track(), 5_000);
    this.trackTimer.unref();
  }

  /**
   * Records every process group that appears in a running session (on its tty or
   * below its leader), so groups that outlive a server crash — e.g. `nohup cmd &`
   * — can be found and killed on the next start.
   */
  track(only?: Session): Promise<void> {
    // Serialise runs; collapse bursts so at most one run is waiting.
    if (this.trackQueued > 1) return this.trackChain;
    this.trackQueued++;
    this.trackChain = this.trackChain.then(() => this.trackOnce(only)).finally(() => this.trackQueued--);
    return this.trackChain;
  }

  private async trackOnce(only?: Session) {
    const running = only ? [only] : this.list(false);
    if (!running.length) return;
    try {
      const table = await listAllProcesses();
      for (const s of running) {
        if (!s.running || !s.pid) continue;
        const tty = s.tty?.replace(/^\/dev\//, '');
        const members = new Map<number, number>();
        for (const p of descendants(table, s.pid)) members.set(p.pid, p.pgid);
        if (tty) for (const p of table) if (p.tty === tty) members.set(p.pid, p.pgid);
        let changed = false;
        for (const pgid of new Set(members.values())) {
          if (pgid <= 1 || pgid === this.ownPgid) continue;
          if (s.trackedGroups.has(pgid) && s.trackedGroups.get(pgid) !== undefined) continue;
          let start = await processStartTime(pgid);
          if (start === undefined && groupAlive(pgid)) {
            await sleep(150);
            start = await processStartTime(pgid);
          }
          if (!s.trackedGroups.has(pgid) || start !== undefined) {
            s.trackedGroups.set(pgid, start);
            changed = true;
          }
        }
        if (changed) {
          this.d.registry.setGroups(s.id, [...s.trackedGroups].map(([pgid, start]) => ({ pgid, start })));
        }
      }
    } catch (e) {
      log.debug('process tracking failed', e);
    }
  }

  allowedRoots(): string[] {
    return this.cfg.security.allowed_roots.map((r) => realpathLoose(expandHome(r)));
  }

  defaultCwd(): string {
    const c = this.cfg.security.default_cwd;
    return realpathLoose(expandHome(c ?? this.cfg.security.allowed_roots[0] ?? '~'));
  }

  resolveCwd(cwd?: string): string {
    const raw = cwd ? expandHome(cwd) : this.defaultCwd();
    const p = realpathLoose(raw.startsWith('/') ? raw : join(this.defaultCwd(), raw));
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      throw new TerminalError('CWD_NOT_FOUND', `working directory does not exist: ${p}`, 'pass an existing directory as cwd');
    }
    const roots = this.allowedRoots();
    if (!roots.some((r) => p === r || isWithin(p, r))) {
      throw new TerminalError('CWD_NOT_ALLOWED', `cwd ${p} is outside the allowed roots`, `allowed roots: ${roots.join(', ')} (configure security.allowed_roots or --root)`);
    }
    return p;
  }

  sandboxSpec(): SandboxSpec {
    const sb = this.cfg.security.sandbox;
    const sd = this.d.stateDir;
    return {
      allowWrite: sb.allow_write,
      denyRead: sb.deny_read,
      network: sb.network,
      extraRules: sb.extra_rules,
      protectedWrite: [sd, this.d.configDir],
      protectedRead: [join(sd, 'sessions'), join(sd, 'approvals'), join(sd, 'audit'), join(sd, 'registry.sqlite'), this.d.configDir],
    };
  }

  runningCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.running) n++;
    return n;
  }

  async create(o: CreateOptions): Promise<Session> {
    if (this.closing) throw new TerminalError('INTERNAL', 'server is shutting down');
    await this.d.env.whenReady();
    if (this.runningCount() >= this.cfg.limits.max_sessions) {
      throw new TerminalError('QUOTA_EXCEEDED', `at most ${this.cfg.limits.max_sessions} running sessions`, 'close sessions you no longer need (terminal_list, then terminal_close)');
    }
    if (o.name !== undefined) {
      if (!NAME_RE.test(o.name)) throw new TerminalError('INVALID_ARGUMENT', `invalid session name "${o.name}"`, 'use letters, digits, ".", "_" or "-" (max 64)');
      for (const s of this.sessions.values()) {
        if (s.name === o.name && s.running) throw new TerminalError('NAME_IN_USE', `a running session is already named "${o.name}" (${s.id})`, 'reuse it, close it, or pick another name');
      }
    }
    const cwd = this.resolveCwd(o.cwd);
    const profile = this.cfg.security.profile;
    let sandbox = o.sandbox ?? profile;
    if (profile === 'workspace' && sandbox === 'host') {
      throw new TerminalError('POLICY_DENIED', 'the server runs in workspace (sandboxed) mode; sessions cannot opt out of the sandbox', 'ask the user to change security.profile if host access is really needed');
    }
    if (sandbox === 'workspace' && !sandboxAvailable()) {
      throw new TerminalError('SANDBOX_UNAVAILABLE', '/usr/bin/sandbox-exec is not available', 'set security.profile = "host" to run without the macOS sandbox');
    }
    const id = newSessionId();
    const runDir = ensureDir(join(this.d.stateDir, 'run', id));
    const spillDir = join(this.d.stateDir, 'sessions', id);
    const env = this.d.env.build(o.env ?? {}, id);
    if (o.mode === 'pipe') {
      env.TERM = 'dumb';
      env.NO_COLOR = env.NO_COLOR ?? '1';
    }
    const cols = o.cols ?? this.cfg.limits.default_cols;
    const rows = o.rows ?? this.cfg.limits.default_rows;

    let argv: string[];
    let display: string;
    let integration: Integration = 'off';
    let nonce: string | undefined;
    let shellKind;
    if (o.kind === 'shell') {
      nonce = newNonce();
      const shell = o.program ? resolveExecutable(o.program, env, cwd) : this.d.shell;
      if (!shell) throw new TerminalError('PROGRAM_NOT_FOUND', `shell not found: ${o.program}`);
      const prep = prepareShell({
        shell,
        nonce,
        runDir,
        rc: this.cfg.shell.rc,
        history: this.cfg.shell.history,
        login: this.cfg.shell.login,
        scrubPatterns: this.cfg.security.env.scrub_after_rc ? this.cfg.security.env.deny_patterns : [],
        userZdotdir: process.env.ZDOTDIR,
      });
      argv = prep.argv;
      Object.assign(env, prep.env);
      if (sandbox === 'workspace' && prep.kind === 'zsh') {
        // Home is read-only inside the sandbox: keep zsh/oh-my-zsh caches in a writable place
        // instead of printing "Operation not permitted" on every start.
        const cache = darwinUserCacheDir();
        if (cache) {
          const dir = ensureDir(join(cache, 'mcp-terminal', 'zsh'));
          env.ZSH_COMPDUMP = env.ZSH_COMPDUMP ?? join(dir, 'zcompdump');
          env.ZSH_CACHE_DIR = env.ZSH_CACHE_DIR ?? ensureDir(join(dir, 'cache'));
        }
      }
      integration = prep.integration ? 'active' : 'degraded';
      shellKind = prep.kind;
      display = shell;
    } else if (o.kind === 'program') {
      if (!o.program) throw new TerminalError('INVALID_ARGUMENT', 'program is required');
      const exe = resolveExecutable(o.program, env, cwd);
      if (!exe) throw new TerminalError('PROGRAM_NOT_FOUND', `program not found on PATH: ${o.program}`, 'pass an absolute path or check the PATH of the session (terminal_run "echo $PATH")');
      argv = [exe, ...(o.args ?? [])];
      display = [o.program, ...(o.args ?? [])].join(' ');
    } else {
      if (!o.command) throw new TerminalError('INVALID_ARGUMENT', 'command is required');
      argv = [this.d.shell, ...(this.cfg.shell.login ? ['-l'] : []), '-c', o.command];
      display = o.command;
    }
    if (sandbox === 'workspace') {
      const resolved = resolveSandbox(this.sandboxSpec(), cwd);
      argv = wrapArgv(writeProfile(runDir, resolved.profile), argv);
    } else sandbox = 'host';

    const s = new Session({
      id,
      name: o.name,
      kind: o.kind,
      mode: o.mode,
      sandbox,
      argv,
      displayCommand: display,
      cwd,
      cols,
      rows,
      ringBytes: this.cfg.limits.ring_buffer_bytes,
      spillDir,
      spillMaxBytes: this.cfg.limits.spill_max_bytes,
      runDir,
      nonce,
      integration,
      shellKind,
      idleTtlS: o.idleTtlS ?? this.cfg.limits.idle_ttl_s,
    });
    const handlers = {
      onData: (stream: 'pty' | 'stdout' | 'stderr', buf: Buffer, text: string) => s.handleData(stream, buf, text),
      onExit: (info: { code: number | null; signal: string | null; error?: string }) => s.handleExit(info),
    };
    let backend: Backend;
    const spec = { file: argv[0]!, args: argv.slice(1), cwd, env, cols, rows };
    try {
      backend = o.mode === 'pty' ? new PtyBackend(spec, handlers) : new PipeBackend(spec, handlers, o.stdin, o.keepStdinOpen);
    } catch (e) {
      s.dispose();
      throw new TerminalError('SPAWN_FAILED', `failed to start ${display}: ${(e as Error).message}`);
    }
    s.attach(backend);
    this.sessions.set(id, s);
    s.pidStart = await processStartTime(s.pid!);
    this.d.registry.insert({
      id,
      name: o.name ?? null,
      instance: this.d.instanceId,
      kind: o.kind,
      mode: o.mode,
      sandbox,
      state: 'running',
      pid: s.pid ?? null,
      pgid: s.pgid ?? null,
      pid_start: s.pidStart ?? null,
      tty: s.tty ?? null,
      command: display,
      cwd,
      created_at: s.createdAt,
      ended_at: null,
      exit_code: null,
      signal: null,
      spill_dir: spillDir,
      run_dir: runDir,
    });
    s.once('exit', (info: { code: number | null; signal: string | null; error?: string; at: number }) => {
      try {
        this.d.registry.update(id, { state: s.state, ended_at: info.at, exit_code: info.code, signal: info.signal });
      } catch (e) {
        log.warn('registry update failed', e);
      }
      this.d.audit.write({
        event: 'session_exit',
        session_id: id,
        state: s.state,
        exit_code: info.code,
        signal: info.signal,
        error: info.error,
        output_bytes: s.endSeq,
        ...(this.cfg.audit.record_output === 'hash' ? { output_sha256: s.outputHash.copy().digest('hex') } : {}),
      });
      s.backend?.dispose();
    });
    this.d.audit.write({ event: 'session_start', session_id: id, kind: o.kind, mode: o.mode, sandbox, cwd, command: display, pid: s.pid, name: o.name });
    return s;
  }

  get(ref: string): Session {
    const direct = this.sessions.get(ref);
    if (direct) return direct;
    let byName: Session | undefined;
    for (const s of this.sessions.values()) {
      if (s.name === ref && (!byName || (s.running && !byName.running) || s.createdAt > byName.createdAt)) byName = s;
    }
    if (byName) return byName;
    const hist = this.loadHistorical(ref);
    if (hist) return hist;
    throw new TerminalError('SESSION_NOT_FOUND', `no session "${ref}"`, 'call terminal_list to see existing sessions');
  }

  /** Re-opens the output of a session from a previous server run (read-only). */
  private loadHistorical(id: string): Session | undefined {
    if (!/^term_[a-z0-9]+$/.test(id)) return undefined;
    const row = this.d.registry.get(id);
    if (!row || row.state === 'running' || !existsSync(row.spill_dir)) return undefined;
    const s = new Session({
      id: row.id,
      name: row.name ?? undefined,
      kind: row.kind as SessionKind,
      mode: row.mode as SessionMode,
      sandbox: row.sandbox as 'workspace' | 'host',
      argv: [],
      displayCommand: row.command,
      cwd: row.cwd,
      cols: 80,
      rows: 24,
      ringBytes: 64 * 1024,
      spillDir: row.spill_dir,
      spillMaxBytes: 0,
      runDir: row.run_dir,
      integration: 'off',
      idleTtlS: 0,
      readOnly: true,
      createdAt: row.created_at,
    });
    s.state = row.state as Session['state'];
    s.exit = { code: row.exit_code, signal: row.signal, at: row.ended_at ?? row.created_at };
    this.sessions.set(id, s);
    return s;
  }

  list(includeEnded = true): Session[] {
    return [...this.sessions.values()].filter((s) => includeEnded || s.running).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Terminates every process that belongs to the session: the session leader,
   * all process groups on its tty, and descendants that escaped via setsid.
   * Escalates SIGHUP/SIGTERM -> SIGKILL after `graceMs`.
   */
  async terminate(s: Session, graceMs = 2000, first?: NodeJS.Signals): Promise<TerminateResult> {
    const res: TerminateResult = { signals: [], killed_groups: [], leftover: [] };
    if (!s.pid) return res;
    s.killRequested = true;
    const collect = async () => {
      const groups = new Set<number>();
      const pids = new Set<number>();
      if (s.pgid) groups.add(s.pgid);
      for (const p of await s.ttyProcs()) {
        groups.add(p.pgid);
        pids.add(p.pid);
      }
      try {
        const table = await listAllProcesses();
        for (const p of descendants(table, s.pid!)) {
          groups.add(p.pgid);
          pids.add(p.pid);
        }
      } catch {
        /* ignore */
      }
      groups.delete(this.ownPgid);
      groups.delete(0);
      groups.delete(1);
      // Groups seen earlier that escaped the tty/process tree (setsid, reparented to launchd).
      for (const [pgid, start] of s.trackedGroups) {
        if (groups.has(pgid) || pgid === this.ownPgid || !groupAlive(pgid)) continue;
        if (start && (await processStartTime(pgid)) === start) groups.add(pgid);
      }
      pids.delete(process.pid);
      return { groups: [...groups], pids: [...pids] };
    };
    const send = (sig: NodeJS.Signals, groups: number[], pids: number[]) => {
      res.signals.push(sig);
      for (const g of groups) signalGroup(g, sig);
      for (const p of pids) signalPid(p, sig);
    };
    const alive = (groups: number[], pids: number[]) => groups.some(groupAlive) || pids.some(isAlive);
    let { groups, pids } = await collect();
    res.killed_groups = groups;
    const steps: NodeJS.Signals[] = first ? [first] : s.mode === 'pty' ? ['SIGHUP', 'SIGTERM'] : ['SIGTERM'];
    const per = Math.max(100, Math.floor(graceMs / steps.length));
    for (const sig of steps) {
      send(sig, groups, pids);
      const until = Date.now() + per;
      while (Date.now() < until && alive(groups, pids)) await sleep(50);
      if (!alive(groups, pids)) break;
      ({ groups, pids } = await collect().then((c) => ({ groups: [...new Set([...groups, ...c.groups])], pids: [...new Set([...pids, ...c.pids])] })));
    }
    if (alive(groups, pids)) {
      send('SIGKILL', groups, pids);
      await sleep(100);
    }
    s.backend?.kill('SIGKILL');
    res.leftover = pids.filter(isAlive);
    // Wait briefly for the exit event so the final state is recorded.
    if (s.running) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1000);
        s.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    if (s.running) s.handleExit({ code: null, signal: 'SIGKILL' });
    return res;
  }

  async close(s: Session, graceMs = 2000, keepOutput = true, reason = 'client'): Promise<TerminateResult> {
    const res = s.running ? await this.terminate(s, graceMs) : { signals: [], killed_groups: [], leftover: [] };
    this.d.audit.write({ event: 'session_close', session_id: s.id, reason, signals: res.signals, leftover: res.leftover });
    if (!keepOutput) this.forget(s, true);
    return res;
  }

  private forget(s: Session, deleteFiles: boolean) {
    s.dispose();
    this.sessions.delete(s.id);
    if (deleteFiles) {
      for (const dir of [s.spillDir, s.runDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      try {
        this.d.registry.delete(s.id);
      } catch {
        /* ignore */
      }
    }
  }

  async shutdown(graceMs = 1500) {
    if (this.closing) return;
    this.closing = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.trackTimer) clearInterval(this.trackTimer);
    const running = this.list(false);
    await Promise.all(running.map((s) => this.terminate(s, graceMs).catch(() => undefined)));
    for (const s of running) this.d.audit.write({ event: 'session_close', session_id: s.id, reason: 'server_shutdown' });
    for (const s of this.sessions.values()) s.dispose();
  }

  /** Startup: kill sessions left behind by crashed server instances. */
  async reconcile() {
    const reg = this.d.registry;
    const dead = new Set<string>();
    for (const inst of reg.instances()) {
      if (inst.id === this.d.instanceId) continue;
      let gone = !isAlive(inst.pid);
      if (!gone && inst.pid_start) gone = (await processStartTime(inst.pid)) !== inst.pid_start;
      if (gone) dead.add(inst.id);
    }
    const rows = reg.byState(['running', 'starting']);
    for (const row of rows) {
      if (row.instance === this.d.instanceId) continue;
      const known = reg.instances().some((i) => i.id === row.instance);
      if (known && !dead.has(row.instance)) continue;
      await this.killOrphan(row);
    }
    for (const id of dead) reg.removeInstance(id);
  }

  private async killOrphan(row: SessionRow) {
    let killed = false;
    const groups = new Set<number>();
    if (row.pid && isAlive(row.pid)) {
      const start = await processStartTime(row.pid);
      if (start && start === row.pid_start) {
        const table = await listAllProcesses();
        for (const p of descendants(table, row.pid)) groups.add(p.pgid);
        if (row.pgid) groups.add(row.pgid);
      }
    }
    // Groups recorded by the tracker; only if the group leader is still the same process.
    try {
      for (const g of JSON.parse(row.groups ?? '[]') as { pgid: number; start?: string }[]) {
        if (groups.has(g.pgid) || !g.start || !groupAlive(g.pgid)) continue;
        if ((await processStartTime(g.pgid)) === g.start) groups.add(g.pgid);
      }
    } catch {
      /* ignore malformed */
    }
    groups.delete(this.ownPgid);
    groups.delete(0);
    groups.delete(1);
    if (groups.size) {
      for (const sig of ['SIGHUP', 'SIGTERM'] as NodeJS.Signals[]) {
        for (const g of groups) signalGroup(g, sig);
        await sleep(300);
        if (![...groups].some(groupAlive)) break;
      }
      for (const g of groups) if (groupAlive(g)) signalGroup(g, 'SIGKILL');
      killed = true;
    }
    this.d.registry.update(row.id, { state: 'lost', ended_at: Date.now() });
    this.d.audit.write({ event: 'reconcile', session_id: row.id, killed_orphan: killed, groups: [...groups], previous_instance: row.instance });
    log.info(`reconciled session ${row.id} from a previous server run (${killed ? 'killed orphaned processes' : 'no live processes'})`);
  }

  async sweep() {
    const now = Date.now();
    const lim = this.cfg.limits;
    for (const s of this.list(true)) {
      if (s.running && s.idleTtlS > 0) {
        const last = Math.max(s.lastOutputAt, s.lastInteractionAt);
        if (now - last > s.idleTtlS * 1000) {
          log.info(`closing idle session ${s.id}`);
          await this.close(s, 2000, true, 'idle_ttl').catch(() => undefined);
        }
      } else if (!s.running && s.exit && now - Math.max(s.exit.at, s.lastInteractionAt) > lim.retain_after_exit_s * 1000) {
        this.forget(s, false);
      }
    }
    // Global memory budget: shrink the least recently active ring buffers first (data stays in the spill log).
    let total = 0;
    for (const s of this.sessions.values()) total += s.ring.size;
    if (total > lim.global_buffer_bytes) {
      const byAge = this.list(true).sort((a, b) => Math.max(a.lastOutputAt, a.lastInteractionAt) - Math.max(b.lastOutputAt, b.lastInteractionAt));
      for (const s of byAge) {
        if (total <= lim.global_buffer_bytes) break;
        const before = s.ring.size;
        s.ring.evict(Math.floor(lim.ring_buffer_bytes / 4));
        total -= before - s.ring.size;
      }
    }
    // Retention of on-disk output.
    if (lim.spill_retention_days > 0) {
      for (const row of this.d.registry.olderThan(now - lim.spill_retention_days * 86400_000)) {
        if (this.sessions.has(row.id)) continue;
        for (const dir of [row.spill_dir, row.run_dir]) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        this.d.registry.delete(row.id);
      }
    }
  }
}
