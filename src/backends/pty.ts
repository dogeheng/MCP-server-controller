import * as pty from 'node-pty';
import { fixNodePty } from '../util/node-pty-fix.js';
import { log } from '../util/log.js';
import { signalName, type Backend, type BackendHandlers, type SpawnSpec } from './types.js';

let helperChecked = false;

export class PtyBackend implements Backend {
  readonly mode = 'pty' as const;
  readonly pid: number;
  readonly pgid: number;
  readonly tty: string | undefined;
  private p: pty.IPty;
  private exited = false;
  private disposables: { dispose(): void }[] = [];

  constructor(spec: SpawnSpec, h: BackendHandlers) {
    if (!helperChecked) {
      helperChecked = true;
      try {
        const fixed = fixNodePty();
        if (fixed.length) log.warn('fixed node-pty spawn-helper permissions', fixed);
      } catch (e) {
        log.warn('could not verify node-pty spawn-helper', e);
      }
    }
    this.p = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
      encoding: 'utf8',
    });
    this.pid = this.p.pid;
    this.pgid = this.p.pid; // node-pty makes the child a session + group leader
    this.tty = (this.p as unknown as { _pty?: string })._pty;
    this.disposables.push(
      this.p.onData((text: string) => h.onData('pty', Buffer.from(text, 'utf8'), text)),
      this.p.onExit(({ exitCode, signal }) => {
        this.exited = true;
        const sig = signalName(signal);
        h.onExit({ code: sig ? null : exitCode, signal: sig });
      }),
    );
  }

  write(data: string) {
    if (!this.exited) this.p.write(data);
  }
  endInput() {
    // Ctrl-D at the start of a line is EOF for the tty line discipline.
    this.write('\x04');
  }
  resize(cols: number, rows: number) {
    if (!this.exited) this.p.resize(cols, rows);
  }
  pause() {
    if (!this.exited) this.p.pause();
  }
  resume() {
    if (!this.exited) this.p.resume();
  }
  foregroundName() {
    try {
      return this.exited ? undefined : this.p.process;
    } catch {
      return undefined;
    }
  }
  kill(sig: NodeJS.Signals) {
    if (this.exited) return;
    try {
      this.p.kill(sig);
    } catch {
      /* already gone */
    }
  }
  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    if (!this.exited) this.kill('SIGKILL');
  }
}
