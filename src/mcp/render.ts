import { TerminalError } from '../core/errors.js';
import type { Session } from '../core/session.js';

export interface ToolResult {
  [k: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type TextFormat = 'render' | 'json' | 'both';

let format: TextFormat = 'render';
export function setTextFormat(f: TextFormat) {
  format = f;
}

function clean(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Builds a tool result: a compact human/LLM-readable text block (header line,
 * body, hint) plus the same data as structuredContent.
 */
export function ok(data: Record<string, unknown>, header: string, body?: string, hint?: string): ToolResult {
  const structured = clean(hint ? { ...data, hint } : data);
  let text = header;
  if (body !== undefined && body !== '') text += `\n${body.replace(/\n$/, '')}`;
  if (hint) text += `\n— ${hint}`;
  if (format === 'json') text = JSON.stringify(structured, null, 1);
  else if (format === 'both') text += `\n\n${JSON.stringify(structured)}`;
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function fail(e: unknown): ToolResult {
  const err =
    e instanceof TerminalError
      ? e
      : new TerminalError('INTERNAL', e instanceof Error ? e.message : String(e), 'this is a server bug or an unexpected environment problem; see the server log');
  const structured = clean({ error: clean({ code: err.code, message: err.message, hint: err.hint, ...(err.details ?? {}) }) });
  let text = `ERROR ${err.code}: ${err.message}`;
  if (err.hint) text += `\n— ${err.hint}`;
  if (err.details && Object.keys(err.details).length) text += `\n${JSON.stringify(err.details)}`;
  return { isError: true, content: [{ type: 'text', text }], structuredContent: structured };
}

export function sessionTag(s: Session, extra?: string) {
  const parts = [s.id];
  if (s.name) parts.push(`"${s.name}"`);
  parts.push(s.state);
  if (extra) parts.push(extra);
  return `[${parts.join(' · ')}]`;
}

export function fmtExit(s: Session): string | undefined {
  if (!s.exit) return undefined;
  if (s.exit.error) return `failed: ${s.exit.error}`;
  if (s.exit.signal) return `killed by ${s.exit.signal}`;
  if (s.exit.code === null || s.exit.code === undefined) return s.state === 'lost' ? 'lost (server restarted)' : s.state;
  return `exit ${s.exit.code}`;
}

export function summary(s: Session) {
  return clean({
    session_id: s.id,
    name: s.name,
    kind: s.kind,
    mode: s.mode,
    state: s.state,
    command: s.displayCommand,
    cwd: s.cwd,
    sandbox: s.sandbox,
    pid: s.pid,
    exit_code: s.exit?.code ?? undefined,
    signal: s.exit?.signal ?? undefined,
    created_at: new Date(s.createdAt).toISOString(),
    last_output_at: new Date(s.lastOutputAt).toISOString(),
    output_bytes: s.endSeq,
    unread_bytes: Math.max(0, s.endSeq - s.clientCursor),
  });
}
