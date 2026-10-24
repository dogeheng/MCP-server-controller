import { TerminalError } from './errors.js';

const NAMED: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  's-tab': '\x1b[Z',
  backtab: '\x1b[Z',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  insert: '\x1b[2~',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  space: ' ',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};

const CURSOR: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };

export const KEY_HELP =
  'Enter, Tab, S-Tab, Escape, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, Insert, F1-F12, Space, C-a..C-z (e.g. C-c, C-d), C-[ C-] C-\\ C-^ C-_ C-@, M-<key> (Alt)';

function normalise(k: string): string {
  let s = k.trim();
  if (/^\^.$/.test(s)) s = `c-${s[1]}`;
  s = s.replace(/^(ctrl|control|ctl)[+-]/i, 'c-').replace(/^(alt|meta|option|opt)[+-]/i, 'm-').replace(/^shift[+-]tab$/i, 's-tab');
  if (/^[cmCM]-.$/.test(s)) return s[0]!.toLowerCase() + s.slice(1);
  return s.toLowerCase();
}

export function keyToSequence(key: string, appCursor = false): string {
  const k = normalise(key);
  if (NAMED[k] !== undefined) return NAMED[k]!;
  if (CURSOR[k]) return (appCursor ? '\x1bO' : '\x1b[') + CURSOR[k];
  if (k.startsWith('c-') && k.length === 3) {
    const ch = k[2]!;
    const lower = ch.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
    const special: Record<string, number> = { '@': 0, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, _: 31, '?': 127 };
    if (special[ch] !== undefined) return String.fromCharCode(special[ch]!);
  }
  if (k.startsWith('m-') && k.length >= 3) {
    const rest = key.trim().slice(key.trim().indexOf('-') + 1);
    return `\x1b${rest.length === 1 ? rest : keyToSequence(rest, appCursor)}`;
  }
  throw new TerminalError('INVALID_ARGUMENT', `unknown key "${key}"`, `valid keys: ${KEY_HELP}`);
}
