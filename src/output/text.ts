// Terminal byte-stream helpers: escape-sequence scanning, plain-text rendering
// (CR/BS/erase aware), raw-view sanitising and UTF-8 boundary alignment.

const ESC = '\x1b';
const BEL = '\x07';
const MAX_STRING_SEQ = 64 * 1024;

export type EscKind = 'csi' | 'osc' | 'str' | 'esc';
export interface EscToken {
  kind: EscKind;
  end: number; // index after the sequence
  params?: string; // CSI params (including private markers like '?')
  final?: string; // CSI final byte
  payload?: string; // OSC payload
}

/** Scans an escape sequence starting at s[i] === ESC. Returns null if incomplete. */
export function scanEscape(s: string, i: number): EscToken | null {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c = s[i + 1]!;
  if (c === '[') {
    let j = i + 2;
    while (j < n) {
      const code = s.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) {
        return { kind: 'csi', end: j + 1, params: s.slice(i + 2, j), final: s[j]! };
      }
      if (code < 0x20 || code > 0x7e) return { kind: 'csi', end: j, params: s.slice(i + 2, j), final: '' };
      j++;
    }
    return null;
  }
  if (c === ']' || c === 'P' || c === 'X' || c === '^' || c === '_') {
    let j = i + 2;
    while (j < n) {
      const ch = s[j]!;
      if (ch === BEL && c === ']') return { kind: 'osc', end: j + 1, payload: s.slice(i + 2, j) };
      if (ch === ESC) {
        if (j + 1 >= n) return null;
        if (s[j + 1] === '\\') {
          return c === ']'
            ? { kind: 'osc', end: j + 2, payload: s.slice(i + 2, j) }
            : { kind: 'str', end: j + 2 };
        }
        // An unterminated string sequence interrupted by another escape.
        return { kind: c === ']' ? 'osc' : 'str', end: j, payload: s.slice(i + 2, j) };
      }
      if (j - i > MAX_STRING_SEQ) return { kind: c === ']' ? 'osc' : 'str', end: j, payload: '' };
      j++;
    }
    return null;
  }
  // ESC [intermediates 0x20-0x2f]* final 0x30-0x7e
  let j = i + 1;
  while (j < n) {
    const code = s.charCodeAt(j);
    if (code >= 0x20 && code <= 0x2f) {
      j++;
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) return { kind: 'esc', end: j + 1 };
    return { kind: 'esc', end: j };
  }
  return null;
}

/** Index of an incomplete escape sequence at the end of `s`, or -1. */
export function incompleteEscapeAt(s: string): number {
  const from = Math.max(0, s.length - MAX_STRING_SEQ);
  let i = s.indexOf(ESC, from);
  while (i !== -1) {
    const tok = scanEscape(s, i);
    if (!tok) return i;
    i = s.indexOf(ESC, tok.end);
  }
  return -1;
}

export interface TextOptions {
  keepColor?: boolean;
}

/**
 * Renders terminal output as plain text: strips escape sequences, applies
 * carriage-return overwrites (so progress bars collapse to their final state),
 * backspaces, erase-in-line and horizontal cursor moves, and collapses runs of
 * blank lines.
 */
export function toText(s: string, opts: TextOptions = {}): string {
  const out: string[] = [];
  let line: string[] = [];
  let col = 0;
  const put = (ch: string) => {
    while (line.length < col) line.push(' ');
    line[col] = ch;
    col++;
  };
  const flush = () => {
    out.push(line.join('').replace(/\s+$/u, ''));
    line = [];
    col = 0;
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    if (ch === ESC) {
      const tok = scanEscape(s, i);
      if (!tok) break; // incomplete trailing sequence
      if (tok.kind === 'csi') {
        const f = tok.final;
        const p = tok.params ?? '';
        const num = Number.parseInt(p.replace(/^[?>=<]/, ''), 10);
        if (f === 'K') {
          if (!p || p === '0') line.length = Math.min(line.length, col);
          else if (p === '1') for (let k = 0; k < Math.min(col, line.length); k++) line[k] = ' ';
          else if (p === '2') line = [];
        } else if (f === 'G' || f === '`') col = Math.max(0, (Number.isNaN(num) ? 1 : num) - 1);
        else if (f === 'C') col += Number.isNaN(num) || num < 1 ? 1 : num;
        else if (f === 'D') col = Math.max(0, col - (Number.isNaN(num) || num < 1 ? 1 : num));
        else if (f === 'm' && opts.keepColor) {
          for (const c of s.slice(i, tok.end)) put(c);
        }
      }
      i = tok.end;
      continue;
    }
    if (ch === '\n') {
      flush();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (s[i + 1] === '\n') {
        flush();
        i += 2;
        continue;
      }
      col = 0;
      i++;
      continue;
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1);
      i++;
      continue;
    }
    if (ch === '\t') {
      put('\t');
      i++;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      i++;
      continue;
    }
    // Keep surrogate pairs together.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      put(s.slice(i, i + 2));
      i += 2;
      continue;
    }
    put(ch);
    i++;
  }
  const endsWithNewline = line.length === 0 && col === 0;
  if (!endsWithNewline) out.push(line.join('').replace(/\s+$/u, ''));
  let text = out.join('\n');
  if (endsWithNewline && out.length) text += '\n';
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Raw view: keeps text, CSI and simple escapes but removes sequences that are
 * dangerous or meaningless to an agent: OSC (titles, clipboard OSC 52,
 * hyperlinks OSC 8, shell-integration marks), DCS, SOS, PM and APC.
 */
export function sanitizeRaw(s: string): string {
  let out = '';
  let last = 0;
  let i = s.indexOf(ESC);
  while (i !== -1) {
    const tok = scanEscape(s, i);
    if (!tok) {
      out += s.slice(last, i);
      last = s.length;
      break;
    }
    if (tok.kind === 'osc' || tok.kind === 'str') {
      out += s.slice(last, i);
      last = tok.end;
    }
    i = s.indexOf(ESC, tok.end);
  }
  out += s.slice(last);
  return out.replace(/[\x00-\x06\x0e-\x1a\x1c-\x1f\x7f]/g, '');
}

/** Length of the longest prefix of `buf` that does not end inside a UTF-8 sequence. */
export function utf8CompleteLength(buf: Buffer): number {
  const n = buf.length;
  for (let back = 1; back <= Math.min(4, n); back++) {
    const b = buf[n - back]!;
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    let need = 1;
    if ((b & 0xe0) === 0xc0) need = 2;
    else if ((b & 0xf0) === 0xe0) need = 3;
    else if ((b & 0xf8) === 0xf0) need = 4;
    return back < need ? n - back : n;
  }
  return n;
}

/** Number of leading continuation bytes (a slice that starts mid-character). */
export function utf8LeadingContinuation(buf: Buffer): number {
  let k = 0;
  while (k < Math.min(3, buf.length) && (buf[k]! & 0xc0) === 0x80) k++;
  return k;
}
