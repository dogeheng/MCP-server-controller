import { constants } from 'node:os';
import { accessSync, constants as fsc, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { StreamId } from '../output/ring-buffer.js';

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  error?: string;
}

export interface BackendHandlers {
  onData(stream: StreamId, data: Buffer, text: string): void;
  onExit(info: ExitInfo): void;
}

export interface Backend {
  readonly mode: 'pty' | 'pipe';
  readonly pid: number;
  /** Process group id of the session leader (pty: pid, pipe: pid because detached). */
  readonly pgid: number;
  readonly tty?: string;
  write(data: string): void;
  endInput(): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  foregroundName(): string | undefined;
  kill(sig: NodeJS.Signals): void;
  dispose(): void;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

const SIGNAL_NAMES = new Map<number, string>(Object.entries(constants.signals).map(([k, v]) => [v as number, k]));
export const signalName = (n: number | undefined | null): string | null => (n ? (SIGNAL_NAMES.get(n) ?? `SIG${n}`) : null);

/** Resolves a program name against PATH (absolute and relative-with-slash paths pass through). */
export function resolveExecutable(file: string, env: Record<string, string>, cwd: string): string | undefined {
  const check = (p: string) => {
    try {
      accessSync(p, fsc.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (file.includes('/')) {
    const p = isAbsolute(file) ? file : join(cwd, file);
    return check(p) ? p : undefined;
  }
  for (const dir of (env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, file);
    if (check(p)) return p;
  }
  return undefined;
}
