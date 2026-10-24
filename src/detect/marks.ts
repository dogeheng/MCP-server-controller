import { scanEscape } from '../output/text.js';

export type MarkType = 'prompt' | 'command_start' | 'command_end' | 'cwd';

export interface Mark {
  type: MarkType;
  seqStart: number; // byte position of the ESC that starts the mark
  seqEnd: number; // byte position right after the mark
  exitCode?: number;
  cwd?: string;
}

/**
 * Streaming scanner for shell-integration marks (OSC 133 A/C/D and OSC 7).
 * Only OSC 133 marks that carry one of the session's nonces are accepted, so a
 * program printing a forged "command finished" sequence cannot fool waiters.
 */
export class MarkScanner {
  private carry = '';
  private carryBase = 0;
  private nonces = new Set<string>();

  constructor(nonce: string) {
    this.nonces.add(nonce);
  }

  addNonce(n: string) {
    this.nonces.add(n);
  }
  removeNonce(n: string) {
    this.nonces.delete(n);
  }

  feed(chunk: string, baseSeq: number): Mark[] {
    let s: string;
    let base: number;
    if (this.carry) {
      s = this.carry + chunk;
      base = this.carryBase;
      this.carry = '';
    } else {
      s = chunk;
      base = baseSeq;
    }
    const marks: Mark[] = [];
    let i = s.indexOf('\x1b]');
    while (i !== -1) {
      const tok = scanEscape(s, i);
      if (!tok) {
        if (s.length - i <= 8192) {
          this.carry = s.slice(i);
          this.carryBase = base + Buffer.byteLength(s.slice(0, i));
        }
        break;
      }
      if (tok.kind === 'osc' && tok.payload !== undefined) {
        const m = this.parse(tok.payload);
        if (m) {
          const start = base + Buffer.byteLength(s.slice(0, i));
          const end = start + Buffer.byteLength(s.slice(i, tok.end));
          marks.push({ ...m, seqStart: start, seqEnd: end });
        }
      }
      i = s.indexOf('\x1b]', tok.end);
    }
    return marks;
  }

  private parse(payload: string): Omit<Mark, 'seqStart' | 'seqEnd'> | null {
    if (payload.startsWith('7;')) {
      try {
        const url = new URL(payload.slice(2));
        if (url.protocol !== 'file:') return null;
        return { type: 'cwd', cwd: decodeURIComponent(url.pathname) };
      } catch {
        return null;
      }
    }
    if (!payload.startsWith('133;')) return null;
    const parts = payload.split(';');
    const kind = parts[1];
    let nonce: string | undefined;
    const positional: string[] = [];
    for (const p of parts.slice(2)) {
      if (p.startsWith('n=')) nonce = p.slice(2);
      else if (!p.includes('=')) positional.push(p);
    }
    if (!nonce || !this.nonces.has(nonce)) return null;
    if (kind === 'A') return { type: 'prompt' };
    if (kind === 'C') return { type: 'command_start' };
    if (kind === 'D') {
      const code = positional.length ? Number.parseInt(positional[0]!, 10) : Number.NaN;
      return { type: 'command_end', exitCode: Number.isNaN(code) ? undefined : code };
    }
    return null;
  }
}
