// stdout is the MCP protocol channel; every diagnostic goes to stderr.
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: number = ORDER[(process.env.MCP_TERMINAL_LOG as Level) ?? 'info'] ?? ORDER.info;

export function setLogLevel(level: Level) {
  threshold = ORDER[level];
}

function emit(level: Level, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const line = `[mcp-terminal ${new Date().toISOString()} ${level}] ${msg}`;
  process.stderr.write(extra === undefined ? `${line}\n` : `${line} ${safe(extra)}\n`);
}

function safe(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
