import { toText } from '../output/text.js';
import { TerminalError } from './errors.js';
import type { Activity, Foreground, Session } from './session.js';

export type UntilCond =
  | { kind: 'exit' }
  | { kind: 'command_done' }
  | { kind: 'input' }
  | { kind: 'idle'; ms: number }
  | { kind: 'pattern'; re: RegExp; src: string }
  | { kind: 'new_output' };

export type WaitReason =
  | 'exited'
  | 'command_finished'
  | 'input_wait_likely'
  | 'idle'
  | 'pattern'
  | 'new_output'
  | 'timeout'
  | 'cancelled';

export const UNTIL_HELP = 'one of "exit", "command_done", "input", "idle:<ms>", "pattern:<regex>"';

export function parseUntil(list: string[] | undefined): UntilCond[] {
  const out: UntilCond[] = [];
  for (const raw of list ?? []) {
    const s = raw.trim();
    if (s === 'exit') out.push({ kind: 'exit' });
    else if (s === 'command_done' || s === 'done') out.push({ kind: 'command_done' });
    else if (s === 'input' || s === 'input_wait') out.push({ kind: 'input' });
    else if (s.startsWith('idle:') || s === 'idle') {
      const ms = s === 'idle' ? 1000 : Number(s.slice(5));
      if (!Number.isFinite(ms) || ms < 50) throw new TerminalError('INVALID_ARGUMENT', `bad until condition "${raw}"`, 'use idle:<milliseconds>, e.g. idle:2000');
      out.push({ kind: 'idle', ms });
    } else if (s.startsWith('pattern:')) {
      const src = s.slice(8);
      try {
        out.push({ kind: 'pattern', re: new RegExp(src, 'm'), src });
      } catch (e) {
        throw new TerminalError('INVALID_ARGUMENT', `invalid regex in "${raw}": ${(e as Error).message}`);
      }
    } else {
      throw new TerminalError('INVALID_ARGUMENT', `unknown until condition "${raw}"`, `use ${UNTIL_HELP}`);
    }
  }
  return out;
}

export interface WaitOptions {
  from: number;
  /** Where pattern matching may start (<= from); lets a wait see a line that was already returned. */
  patternFrom?: number;
  deadline: number;
  signal?: AbortSignal;
  commandId?: string;
  inputMinQuietMs?: number;
  onProgress?: (p: { elapsedMs: number; bytes: number }) => void;
}

export interface WaitResult {
  reason: WaitReason;
  waitedMs: number;
  matched?: string;
  activity?: Activity;
  activityReason?: string;
  foreground?: Foreground;
}

const PATTERN_WINDOW = 1024 * 1024;

function waitChange(s: Session, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      s.off('change', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, Math.max(1, ms));
    s.on('change', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function waitFor(s: Session, conds: UntilCond[], o: WaitOptions): Promise<WaitResult> {
  const t0 = Date.now();
  const patternFloor = Math.min(o.patternFrom ?? o.from, o.from);
  let scanFrom = patternFloor;
  let lastScan = 0;
  let lastProgress = t0;
  let lastInputProbe = 0;
  const has = (k: UntilCond['kind']) => conds.some((c) => c.kind === k);
  const patterns = conds.filter((c): c is Extract<UntilCond, { kind: 'pattern' }> => c.kind === 'pattern');
  const idle = conds.find((c): c is Extract<UntilCond, { kind: 'idle' }> => c.kind === 'idle');
  const result = (reason: WaitReason, extra: Partial<WaitResult> = {}): WaitResult => ({ reason, waitedMs: Date.now() - t0, ...extra });

  for (;;) {
    const now = Date.now();
    const scanDue = !s.running || now - lastScan >= 100 || s.endSeq - scanFrom > 65536;
    if (patterns.length && s.endSeq > scanFrom && scanDue) {
      lastScan = now;
      const from = Math.max(patternFloor, scanFrom - 4096, s.endSeq - PATTERN_WINDOW, s.earliestSeq);
      const slice = s.readRaw(from, s.endSeq - from);
      const text = toText(Buffer.concat(slice.parts.map((p) => p.data)).toString('utf8'));
      scanFrom = s.endSeq;
      for (const p of patterns) {
        const m = p.re.exec(text);
        if (m) return result('pattern', { matched: m[0].slice(0, 500) });
      }
    }
    if (has('command_done')) {
      const cmd = o.commandId
        ? s.commands.find((c) => c.id === o.commandId && c.endSeq !== undefined)
        : s.commands.find((c) => c.endSeq !== undefined && c.endSeq >= o.from);
      if (cmd) return result('command_finished');
    }
    if (!s.running) return result('exited');
    if (has('new_output') && s.endSeq > o.from) {
      // Coalesce a burst of output into one response.
      await waitChange(s, 50, o.signal);
      return result('new_output');
    }
    if (idle && s.quietMs(now) >= idle.ms) return result('idle');
    if (has('input') && s.quietMs(now) >= (o.inputMinQuietMs ?? 600) && now - lastInputProbe >= 250) {
      lastInputProbe = now;
      const a = await s.activity();
      if (a.activity === 'awaiting_input') {
        return result('input_wait_likely', { activity: a.activity, activityReason: a.reason, foreground: a.foreground });
      }
    }
    if (o.signal?.aborted) return result('cancelled');
    if (now >= o.deadline) return result('timeout');
    if (o.onProgress && now - lastProgress >= 2000) {
      lastProgress = now;
      o.onProgress({ elapsedMs: now - t0, bytes: s.endSeq - o.from });
    }
    await waitChange(s, Math.min(250, o.deadline - now), o.signal);
  }
}
