import type { StreamId } from '../output/ring-buffer.js';
import type { Redactor } from '../output/redactor.js';
import { incompleteEscapeAt, sanitizeRaw, toText, utf8CompleteLength, utf8LeadingContinuation } from '../output/text.js';
import type { Session } from './session.js';

export type View = 'text' | 'raw';

export interface Rendered {
  text: string;
  cursor_from: number;
  next_cursor: number;
  has_more: boolean;
  dropped_bytes: number;
  bytes: number;
  redactions: number;
  truncated?: boolean;
  omitted?: { from: number; to: number; bytes: number };
}

function convert(s: string, view: View) {
  return view === 'raw' ? sanitizeRaw(s) : toText(s);
}

/** Reads one page of output starting at `from`. */
export function renderPage(
  s: Session,
  from: number,
  maxBytes: number,
  view: View,
  redactor: Redactor,
  filter?: (st: StreamId) => boolean,
  limit?: number,
): Rendered {
  const cap = limit !== undefined ? Math.max(0, Math.min(maxBytes, limit - from)) : maxBytes;
  const slice = s.readRaw(from, cap, filter);
  let buf = Buffer.concat(slice.parts.map((p) => p.data));
  let end = slice.end;
  const lead = utf8LeadingContinuation(buf);
  if (lead) buf = buf.subarray(lead);
  let str: string;
  const finalBytes = !s.running && end >= s.endSeq;
  if (!filter && !finalBytes) {
    // A full page with more data after it: end the page at a line boundary when one
    // exists in its second half, so lines are not split across pages.
    if (buf.length >= cap - 1 && end < (limit ?? s.endSeq)) {
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0 && nl + 1 < buf.length && nl >= buf.length / 2) {
        end -= buf.length - (nl + 1);
        buf = buf.subarray(0, nl + 1);
      }
    }
    const complete = utf8CompleteLength(buf);
    if (complete < buf.length) {
      end -= buf.length - complete;
      buf = buf.subarray(0, complete);
    }
    str = buf.toString('utf8');
    const idx = incompleteEscapeAt(str);
    if (idx > 0) {
      end -= Buffer.byteLength(str.slice(idx));
      str = str.slice(0, idx);
    }
  } else {
    str = buf.toString('utf8');
  }
  const red = redactor.redact(convert(str, view));
  return {
    text: red.text,
    cursor_from: slice.start,
    next_cursor: end,
    has_more: end < (limit ?? s.endSeq),
    dropped_bytes: slice.dropped,
    bytes: end - slice.start,
    redactions: red.count,
  };
}

/**
 * Renders a closed range [start, end) for command results. Large ranges keep
 * the head (1/3) and the tail (2/3), since errors and summaries usually sit at
 * the end, and report the omitted byte range so it can be paged with terminal_read.
 */
export function renderRange(
  s: Session,
  start: number,
  end: number,
  maxBytes: number,
  view: View,
  redactor: Redactor,
  filter?: (st: StreamId) => boolean,
): Rendered {
  const total = Math.max(0, end - start);
  if (filter) return renderStream(s, start, end, maxBytes, view, redactor, filter);
  if (total <= maxBytes) {
    const r = renderPage(s, start, total, view, redactor, undefined, end);
    return { ...r, next_cursor: Math.max(r.next_cursor, end), has_more: false };
  }
  const headBytes = Math.floor(maxBytes / 3);
  const tailBytes = maxBytes - headBytes;
  const head = renderPage(s, start, headBytes, view, redactor, undefined, end);
  let tailStart = Math.max(head.next_cursor, end - tailBytes);
  // Start the tail at the beginning of a line when one is close by.
  if (tailStart > head.next_cursor) {
    const probe = s.readRaw(tailStart, Math.min(512, end - tailStart));
    const pb = Buffer.concat(probe.parts.map((p) => p.data));
    const nl = pb.indexOf(0x0a);
    if (probe.start === tailStart && nl >= 0 && nl + 1 < pb.length) tailStart += nl + 1;
  }
  const tail = renderPage(s, tailStart, tailBytes, view, redactor, undefined, end);
  const omittedFrom = head.next_cursor;
  const omittedTo = tail.cursor_from + tail.dropped_bytes;
  const omitted = Math.max(0, omittedTo - omittedFrom);
  const marker = `\n…[${omitted} bytes omitted; read them with terminal_read(cursor=${omittedFrom}, max_bytes=…)]…\n`;
  return {
    text: head.text + marker + tail.text,
    cursor_from: start,
    next_cursor: end,
    has_more: false,
    dropped_bytes: head.dropped_bytes,
    bytes: total,
    redactions: head.redactions + tail.redactions,
    truncated: true,
    omitted: { from: omittedFrom, to: omittedTo, bytes: omitted },
  };
}

const STREAM_WINDOW = 8 * 1024 * 1024;

/** One stream (stdout or stderr) of a pipe-mode command, truncated at text level. */
function renderStream(
  s: Session,
  start: number,
  end: number,
  maxBytes: number,
  view: View,
  redactor: Redactor,
  filter: (st: StreamId) => boolean,
): Rendered {
  const head = renderPage(s, start, STREAM_WINDOW, view, redactor, filter);
  let text = head.text;
  let redactions = head.redactions;
  let dropped = false;
  if (head.has_more && head.next_cursor < end) {
    const tail = renderPage(s, Math.max(head.next_cursor, end - STREAM_WINDOW), STREAM_WINDOW, view, redactor, filter);
    text = `${text}\n…[output omitted]…\n${tail.text}`;
    redactions += tail.redactions;
    dropped = true;
  }
  let truncated = dropped;
  if (text.length > maxBytes) {
    const h = Math.floor(maxBytes / 3);
    const t = maxBytes - h;
    const omittedChars = text.length - h - t;
    text = `${text.slice(0, h)}\n…[${omittedChars} characters omitted; page it with terminal_read(session_id="${s.id}", cursor=0, stream=…)]…\n${text.slice(-t)}`;
    truncated = true;
  }
  return {
    text,
    cursor_from: start,
    next_cursor: end,
    has_more: false,
    dropped_bytes: head.dropped_bytes,
    bytes: end - start,
    redactions,
    truncated,
  };
}

/** Last `n` lines of text output (bounded scan window). */
export function renderTail(s: Session, lines: number, view: View, redactor: Redactor, windowBytes = 256 * 1024): Rendered {
  const end = s.endSeq;
  const from = Math.max(s.earliestSeq, end - windowBytes);
  const page = renderPage(s, from, end - from, view, redactor);
  const all = page.text.replace(/\n$/, '').split('\n');
  const kept = all.slice(-lines);
  return { ...page, text: kept.join('\n') + (page.text.endsWith('\n') ? '\n' : ''), truncated: all.length > kept.length };
}
