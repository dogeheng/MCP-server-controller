import { EventEmitter } from 'node:events';
import { createHash, type Hash } from 'node:crypto';
import type { Backend, ExitInfo } from '../backends/types.js';
import { MarkScanner, type Mark } from '../detect/marks.js';
import type { ShellKind } from '../detect/shell.js';
import { RingBuffer, type Slice, type StreamId } from '../output/ring-buffer.js';
import { ScreenModel } from '../output/screen.js';
import { SpillLog } from '../output/spill-log.js';
import { newCommandId } from '../util/ids.js';
import { ttyProcesses, type ProcInfo } from '../util/proc.js';

export type SessionKind = 'shell' | 'program' | 'command';
export type SessionMode = 'pty' | 'pipe';
export type SessionState = 'starting' | 'running' | 'exited' | 'killed' | 'failed' | 'lost';
export type Activity = 'busy' | 'idle' | 'awaiting_input' | 'unknown';
export type Integration = 'active' | 'degraded' | 'off';

export interface CommandRecord {
  id: string;
  text: string;
  via: 'exec' | 'typed';
  sentSeq: number;
  outputStart?: number;
  endSeq?: number;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
}

export interface SessionInit {
  id: string;
  name?: string;
  kind: SessionKind;
  mode: SessionMode;
  sandbox: 'workspace' | 'host';
  argv: string[];
  displayCommand: string;
  cwd: string;
  cols: number;
  rows: number;
  ringBytes: number;
  spillDir: string;
  spillMaxBytes: number;
  runDir: string;
  nonce?: string;
  integration: Integration;
  shellKind?: ShellKind;
  idleTtlS: number;
  readOnly?: boolean;
  createdAt?: number;
}

export interface Foreground {
  pgid: number;
  pids: number[];
  name: string;
  stat: string;
  isShell: boolean;
}

// ASCII and full-width (CJK) prompt endings.
const PROMPT_TAIL = /(?:[:?>\]$#»❯›)：？＞》】」）]|(?<=\s)%)\s*$/u; // '%' only as a zsh-style "~ %" prompt, not "45%"
const PROMPT_WORDS =
  /(password|passphrase|passcode|\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]|continue\?|overwrite\?|press (any|enter|return)|请输入|请选择|是否|确认|密码|口令|按任意键|按回车)/iu;
// Punctuation followed by spaces right before the cursor, e.g. input("Name? ") / input("名字： ").
const PROMPT_AT_CURSOR = /[\p{P}\p{S}]\s+$/u;

export function promptLike(line: string): boolean {
  const t = line.replace(/\s+$/u, '');
  if (!t) return false;
  return PROMPT_TAIL.test(t) || PROMPT_WORDS.test(t);
}

/** `beforeCursor` is the untrimmed text left of the cursor on its line. */
export function promptAtCursor(beforeCursor: string): boolean {
  if (!beforeCursor.trim()) return false;
  return PROMPT_AT_CURSOR.test(beforeCursor) || promptLike(beforeCursor);
}

export class Session extends EventEmitter {
  readonly id: string;
  name?: string;
  readonly kind: SessionKind;
  readonly mode: SessionMode;
  readonly sandbox: 'workspace' | 'host';
  readonly argv: string[];
  readonly displayCommand: string;
  readonly cwdInitial: string;
  readonly runDir: string;
  readonly spillDir: string;
  readonly shellKind?: ShellKind;
  readonly createdAt: number;
  cwd: string;
  cols: number;
  rows: number;
  state: SessionState = 'starting';
  exit?: ExitInfo & { at: number };
  integration: Integration;
  ready = false;
  atPrompt = false;
  idleTtlS: number;
  backend?: Backend;
  readonly ring: RingBuffer;
  readonly spill: SpillLog;
  readonly screen?: ScreenModel;
  readonly marks?: MarkScanner;
  commands: CommandRecord[] = [];
  current?: CommandRecord;
  clientCursor = 0;
  lastOutputAt: number;
  lastInteractionAt: number;
  killRequested = false;
  timedOut = false;
  /** Process groups seen in this session (pgid -> leader start time), for crash cleanup. */
  readonly trackedGroups = new Map<number, string | undefined>();
  pid?: number;
  pgid?: number;
  tty?: string;
  pidStart?: string;
  /** Line-editor state tracked for policy checks of keystrokes sent to a shell prompt. */
  lineBuf = '';
  lineUncertain = false;
  promptLine?: string;
  readonly outputHash: Hash = createHash('sha256');
  private rateWindow: { t: number; n: number }[] = [];
  private fgCache?: { at: number; fg: Foreground | undefined; procs: ProcInfo[] };

  constructor(init: SessionInit) {
    super();
    this.setMaxListeners(100);
    this.id = init.id;
    this.name = init.name;
    this.kind = init.kind;
    this.mode = init.mode;
    this.sandbox = init.sandbox;
    this.argv = init.argv;
    this.displayCommand = init.displayCommand;
    this.cwdInitial = this.cwd = init.cwd;
    this.cols = init.cols;
    this.rows = init.rows;
    this.runDir = init.runDir;
    this.spillDir = init.spillDir;
    this.integration = init.integration;
    this.shellKind = init.shellKind;
    this.idleTtlS = init.idleTtlS;
    this.createdAt = init.createdAt ?? Date.now();
    this.lastOutputAt = this.lastInteractionAt = this.createdAt;
    this.ring = new RingBuffer(init.ringBytes);
    this.spill = new SpillLog(init.spillDir, init.spillMaxBytes, undefined, init.readOnly);
    if (init.readOnly) return;
    if (init.mode === 'pty') {
      this.screen = new ScreenModel(init.cols, init.rows, (reply) => this.backend?.write(reply));
    }
    if (init.nonce) this.marks = new MarkScanner(init.nonce);
  }

  get running() {
    return this.state === 'running' || this.state === 'starting';
  }

  get endSeq() {
    return Math.max(this.ring.endSeq, this.spill.endSeq);
  }

  get earliestSeq() {
    return this.spill.enabled && this.spill.endSeq > 0 ? Math.min(this.spill.startSeq, this.ring.startSeq) : this.ring.startSeq;
  }

  attach(b: Backend) {
    this.backend = b;
    this.pid = b.pid;
    this.pgid = b.pgid;
    this.tty = b.tty;
    this.state = 'running';
  }

  handleData(stream: StreamId, buf: Buffer, text: string) {
    const seq = this.ring.append(stream, buf);
    this.spill.append(seq, stream, buf);
    this.outputHash.update(buf);
    if (this.screen) this.screen.write(text);
    if (this.marks) for (const m of this.marks.feed(text, seq)) this.applyMark(m);
    const now = Date.now();
    this.lastOutputAt = now;
    this.rateWindow.push({ t: now, n: buf.length });
    while (this.rateWindow.length && now - this.rateWindow[0]!.t > 1000) this.rateWindow.shift();
    this.emit('change', 'output');
  }

  /** Output rate over the last second, in bytes/s. */
  get outputRate() {
    const now = Date.now();
    return this.rateWindow.filter((r) => now - r.t <= 1000).reduce((s, r) => s + r.n, 0);
  }

  private applyMark(m: Mark) {
    switch (m.type) {
      case 'prompt':
        this.atPrompt = true;
        this.lineBuf = '';
        this.lineUncertain = false;
        this.promptLine = undefined;
        if (this.integration === 'degraded' && this.kind === 'shell') this.integration = 'active';
        if (!this.ready) {
          this.ready = true;
          this.emit('ready');
        }
        break;
      case 'command_start': {
        this.atPrompt = false;
        let cmd = this.current;
        if (!cmd || cmd.outputStart !== undefined) {
          cmd = { id: newCommandId(), text: '', via: 'typed', sentSeq: m.seqStart, startedAt: Date.now() };
          this.pushCommand(cmd);
        }
        cmd.outputStart = m.seqEnd;
        break;
      }
      case 'command_end': {
        const cmd = this.current;
        if (cmd) {
          if (cmd.outputStart === undefined) cmd.outputStart = this.guessOutputStart(cmd.sentSeq, m.seqStart);
          cmd.endSeq = m.seqStart;
          cmd.exitCode = m.exitCode;
          cmd.endedAt = Date.now();
          this.current = undefined;
          this.emit('command_end', cmd);
        }
        break;
      }
      case 'cwd':
        if (m.cwd) this.cwd = m.cwd;
        break;
    }
    this.emit('change', 'mark');
  }

  /** Without a C mark (e.g. bash 3.2), output starts after the echoed command line. */
  private guessOutputStart(from: number, to: number): number {
    const slice = this.readRaw(from, Math.min(64 * 1024, Math.max(0, to - from)));
    let pos = slice.start;
    for (const p of slice.parts) {
      const idx = p.data.indexOf(0x0a);
      if (idx >= 0) return pos + idx + 1;
      pos += p.data.length;
    }
    return to;
  }

  pushCommand(cmd: CommandRecord) {
    this.current = cmd;
    this.commands.push(cmd);
    if (this.commands.length > 50) this.commands.splice(0, this.commands.length - 50);
  }

  handleExit(info: ExitInfo) {
    if (!this.running) return;
    this.state = info.error ? 'failed' : this.killRequested ? 'killed' : 'exited';
    this.exit = { ...info, at: Date.now() };
    this.atPrompt = false;
    this.fgCache = undefined;
    this.emit('change', 'exit');
    this.emit('exit', this.exit);
  }

  write(data: string) {
    if (!this.backend || !this.running) return;
    this.lastInteractionAt = Date.now();
    this.backend.write(data);
  }

  touch() {
    this.lastInteractionAt = Date.now();
  }

  quietMs(now = Date.now()) {
    return now - this.lastOutputAt;
  }

  /**
   * Reads raw bytes starting at `from`, falling back to the spill log for data
   * evicted from memory. `dropped` counts bytes that are no longer available.
   */
  readRaw(from: number, maxBytes: number, filter?: (s: StreamId) => boolean): Slice & { dropped: number } {
    const end = this.endSeq;
    let start = Math.max(0, Math.min(from, end));
    let dropped = 0;
    const earliest = this.earliestSeq;
    if (start < earliest) {
      dropped = earliest - start;
      start = earliest;
    }
    const fromRing = this.ring.read(start, maxBytes, filter);
    if (fromRing) return { ...fromRing, start, dropped };
    const fromSpill = this.spill.read(start, maxBytes, filter);
    if (fromSpill) return { ...fromSpill, start, dropped };
    return { start, end: start, parts: [], dropped };
  }

  async foreground(maxAgeMs = 200): Promise<Foreground | undefined> {
    if (this.mode !== 'pty' || !this.tty || !this.running) return undefined;
    const now = Date.now();
    if (this.fgCache && now - this.fgCache.at < maxAgeMs) return this.fgCache.fg;
    const procs = await ttyProcesses(this.tty);
    const fgProcs = procs.filter((p) => p.pgid === p.tpgid);
    let fg: Foreground | undefined;
    if (fgProcs.length) {
      const leader = fgProcs.find((p) => p.pid === p.pgid) ?? fgProcs[0]!;
      fg = {
        pgid: leader.pgid,
        pids: fgProcs.map((p) => p.pid),
        name: leader.comm.split('/').pop() ?? leader.comm,
        stat: fgProcs.map((p) => p.stat).join(','),
        isShell: leader.pgid === this.pgid && this.kind === 'shell',
      };
    }
    this.fgCache = { at: now, fg, procs };
    return fg;
  }

  /** All processes attached to this session's tty from the last foreground() probe. */
  async ttyProcs(): Promise<ProcInfo[]> {
    if (!this.tty) return [];
    return ttyProcesses(this.tty);
  }

  async activity(): Promise<{ activity: Activity; foreground?: Foreground; reason: string }> {
    if (!this.running) return { activity: 'unknown', reason: `session ${this.state}` };
    if (this.mode === 'pipe') return { activity: 'busy', reason: 'process running (no tty)' };
    if (this.kind === 'shell' && this.integration === 'active' && this.atPrompt) {
      return { activity: 'idle', reason: 'shell is at its prompt' };
    }
    const fg = await this.foreground();
    if (!fg) return { activity: 'unknown', reason: 'no foreground process group' };
    if (fg.isShell && this.integration !== 'active') {
      return { activity: 'idle', reason: 'shell is the foreground process' };
    }
    const quiet = this.quietMs();
    const running = fg.stat.split(',').some((s) => s.startsWith('R'));
    if (fg.stat.split(',').some((s) => s.startsWith('T'))) {
      return { activity: 'unknown', foreground: fg, reason: 'foreground job is stopped' };
    }
    if (!running && quiet >= 400) {
      if (this.screen?.altScreen) return { activity: 'awaiting_input', foreground: fg, reason: 'full-screen app is waiting for keys' };
      const line = this.screen?.cursorLine() ?? '';
      const before = this.screen?.textBeforeCursor() ?? '';
      if (promptLike(line) || promptAtCursor(before)) {
        return { activity: 'awaiting_input', foreground: fg, reason: `prompt-like text on the cursor line: ${JSON.stringify(line.trim().slice(-80))}` };
      }
    }
    return { activity: 'busy', foreground: fg, reason: running ? 'foreground process is running' : 'foreground process is sleeping' };
  }

  dispose() {
    this.backend?.dispose();
    this.screen?.dispose();
    this.spill.close();
    this.removeAllListeners();
  }
}
