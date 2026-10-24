import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { signalGroup } from '../util/proc.js';
import type { Backend, BackendHandlers, SpawnSpec } from './types.js';

/**
 * Non-TTY backend: separate stdout/stderr, stdin pipe. The child is detached so
 * it leads its own process group and the whole tree can be signalled at once.
 */
export class PipeBackend implements Backend {
  readonly mode = 'pipe' as const;
  readonly pid: number;
  readonly pgid: number;
  readonly tty = undefined;
  private cp: ChildProcess;
  private exited = false;
  private reported = false;

  constructor(spec: SpawnSpec, h: BackendHandlers, stdinData?: string, keepStdinOpen = false) {
    this.cp = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.cp.pid ?? -1;
    this.pgid = this.pid;
    const report = (code: number | null, signal: string | null, error?: string) => {
      if (this.reported) return;
      this.reported = true;
      h.onExit({ code, signal, error });
    };
    if (this.pid < 0) {
      // Spawn failure is reported asynchronously via 'error'.
      this.cp.once('error', (e) => {
        this.exited = true;
        report(null, null, e.message);
      });
      return;
    }
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    this.cp.stdout!.on('data', (b: Buffer) => h.onData('stdout', b, outDec.write(b)));
    this.cp.stderr!.on('data', (b: Buffer) => h.onData('stderr', b, errDec.write(b)));
    this.cp.stdin!.on('error', () => {
      /* EPIPE when the child exits before reading stdin */
    });
    let exitArgs: [number | null, string | null] | undefined;
    this.cp.once('exit', (code, signal) => {
      this.exited = true;
      exitArgs = [code, signal];
      // Give stdio a moment to drain; a background grandchild may hold the pipes open.
      setTimeout(() => report(code, signal), 250).unref();
    });
    this.cp.once('close', (code, signal) => {
      const [c, s] = exitArgs ?? [code, signal];
      report(c, s);
    });
    this.cp.once('error', (e) => {
      if (!this.exited) report(null, null, e.message);
    });
    if (stdinData !== undefined) this.cp.stdin!.write(stdinData);
    if (!keepStdinOpen) this.cp.stdin!.end();
  }

  write(data: string) {
    if (!this.exited && this.cp.stdin && !this.cp.stdin.destroyed && this.cp.stdin.writable) this.cp.stdin.write(data);
  }
  endInput() {
    if (this.cp.stdin && !this.cp.stdin.destroyed) this.cp.stdin.end();
  }
  resize() {
    /* no tty */
  }
  pause() {
    this.cp.stdout?.pause();
    this.cp.stderr?.pause();
  }
  resume() {
    this.cp.stdout?.resume();
    this.cp.stderr?.resume();
  }
  foregroundName() {
    return undefined;
  }
  kill(sig: NodeJS.Signals) {
    if (this.pid > 0 && !signalGroup(this.pgid, sig)) {
      try {
        this.cp.kill(sig);
      } catch {
        /* gone */
      }
    }
  }
  dispose() {
    this.cp.stdout?.removeAllListeners('data');
    this.cp.stderr?.removeAllListeners('data');
  }
}
