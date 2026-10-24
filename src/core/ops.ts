import { sentinelSuffix } from '../detect/shell.js';
import { newCommandId, newNonce } from '../util/ids.js';
import { TerminalError } from './errors.js';
import { keyToSequence } from './keys.js';
import type { CommandRecord, Session } from './session.js';
import { parseUntil, waitFor, type UntilCond, type WaitResult } from './waiter.js';

export function waitReady(s: Session, ms: number): Promise<boolean> {
  if (s.ready || s.kind !== 'shell') return Promise.resolve(s.ready || s.kind !== 'shell');
  if (!s.running) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(t);
      s.off('ready', onReady);
      s.off('exit', onExit);
      resolve(v);
    };
    const onReady = () => done(true);
    const onExit = () => done(false);
    const t = setTimeout(() => done(s.ready), ms);
    s.on('ready', onReady);
    s.on('exit', onExit);
  });
}

/** Waits for the first output of a freshly started program, then for it to settle. */
export async function waitStarted(s: Session, ms: number, signal?: AbortSignal): Promise<WaitResult> {
  const deadline = Date.now() + ms;
  const first = await waitFor(s, [{ kind: 'new_output' }], { from: 0, deadline, signal });
  if (first.reason !== 'new_output') return first;
  return waitFor(s, [{ kind: 'idle', ms: 300 }, { kind: 'input' }], { from: 0, deadline, signal });
}

export interface ExecStart {
  cmd: CommandRecord;
  startSeq: number;
}

export function startExec(s: Session, command: string): ExecStart {
  if (s.kind !== 'shell') {
    throw new TerminalError('NOT_SUPPORTED', 'terminal_exec only works on shell sessions', 'use terminal_send to type into a program, or terminal_create a shell session');
  }
  if (!s.running) throw new TerminalError('SESSION_EXITED', `session ${s.id} has ${s.state}`, 'create a new session');
  if (s.integration === 'active' && (s.current || !s.atPrompt)) {
    const busy = s.current;
    throw new TerminalError(
      'SESSION_BUSY',
      busy ? `a command is still running in ${s.id}: ${busy.text || '(typed command)'}` : `the shell in ${s.id} is not at its prompt`,
      'wait with terminal_read(until=["command_done"]), answer it with terminal_send, or interrupt with terminal_send(keys=["C-c"])',
      { command_id: busy?.id },
    );
  }
  const text = command.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const startSeq = s.endSeq;
  const cmd: CommandRecord = { id: newCommandId(), text, via: 'exec', sentSeq: startSeq, startedAt: Date.now() };
  let payload = text;
  if (s.integration !== 'active' && s.marks) {
    const n = newNonce();
    s.marks.addNonce(n);
    payload += sentinelSuffix(n);
  }
  if (payload.includes('\n') && s.screen?.modes.bracketedPasteMode) payload = `\x1b[200~${payload}\x1b[201~`;
  s.pushCommand(cmd);
  s.atPrompt = false;
  s.write(`${payload}\r`);
  return { cmd, startSeq };
}

export interface SendPlan {
  payload: string;
  /** Lines that will be submitted to a shell prompt and must pass the policy check. */
  submitted: string[];
  next: { buf: string; uncertain: boolean };
}

/**
 * Converts text/keys into bytes and simulates a line editor to find out which
 * command lines are submitted to the shell (so policy can check them).
 */
export function planSend(s: Session, text: string | undefined, keys: string[] | undefined, submit: boolean): SendPlan {
  const appCursor = !!s.screen?.modes.applicationCursorKeysMode;
  const pieces: { data: string; isKey: boolean; name?: string }[] = [];
  if (text) pieces.push({ data: text, isKey: false });
  for (const k of keys ?? []) pieces.push({ data: keyToSequence(k, appCursor), isKey: true, name: k });
  if (submit) pieces.push({ data: '\r', isKey: true, name: 'Enter' });
  let buf = s.lineBuf;
  let uncertain = s.lineUncertain;
  const submitted: string[] = [];
  const uncertainSubmits: boolean[] = [];
  for (const p of pieces) {
    let i = 0;
    const d = p.data;
    while (i < d.length) {
      const ch = d[i]!;
      if (ch === '\r' || ch === '\n') {
        submitted.push(buf);
        uncertainSubmits.push(uncertain);
        buf = '';
        uncertain = false;
        if (ch === '\r' && d[i + 1] === '\n') i++;
      } else if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1);
      else if (ch === '\x15' || ch === '\x03') {
        buf = '';
        uncertain = false;
      } else if (ch === '\x17') buf = buf.replace(/\S+\s*$/, '');
      else if (ch === '\x1b') {
        if (d.startsWith('\x1b[200~', i)) {
          i += 6;
          continue;
        }
        if (d.startsWith('\x1b[201~', i)) {
          i += 6;
          continue;
        }
        uncertain = true;
      } else if (ch.charCodeAt(0) < 0x20 && ch !== '\t') uncertain = true;
      else if (ch === '\t') uncertain = true; // completion
      else buf += ch;
      i++;
    }
  }
  const payload = pieces.map((p) => p.data).join('');
  // For submissions whose content we could not track (history recall, completion),
  // fall back to the visible command line on screen.
  const lines = submitted.map((l, idx) => {
    if (!uncertainSubmits[idx]) return l;
    const screenLine = s.screen?.cursorLine() ?? '';
    const prompt = s.promptLine ?? '';
    const fromScreen = prompt && screenLine.startsWith(prompt) ? screenLine.slice(prompt.length) : screenLine;
    return `${l}\n${fromScreen}`.trim();
  });
  return { payload, submitted: lines.filter((l) => l.trim()), next: { buf, uncertain } };
}

export function parseUntilOrDefault(until: string[] | undefined, fallback: UntilCond[]): UntilCond[] {
  const c = parseUntil(until);
  return c.length ? c : fallback;
}
