import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config/schema.js';
import { TerminalError } from '../core/errors.js';
import type { SessionManager } from '../core/manager.js';
import { planSend, startExec, waitReady, waitStarted } from '../core/ops.js';
import type { Session } from '../core/session.js';
import { renderPage, renderRange, renderTail, type Rendered } from '../core/views.js';
import { parseUntil, UNTIL_HELP, waitFor, type UntilCond, type WaitResult } from '../core/waiter.js';
import type { Redactor } from '../output/redactor.js';
import type { AuditLog } from '../store/audit.js';
import { signalGroup } from '../util/proc.js';
import type { Ctx, Guard } from './guard.js';
import { fail, fmtExit, ok, sessionTag, summary, type ToolResult } from './render.js';

export interface ToolDeps {
  mgr: SessionManager;
  guard: Guard;
  redactor: Redactor;
  cfg: Config;
  audit: AuditLog;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGTSTP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH'] as const;

const body = (t: string) => (t.trim() ? t : '(no output)');

/** Right-trims lines and drops trailing blank lines of a screen snapshot. */
const screenText = (lines: string[]) => {
  const out = lines.map((l) => l.replace(/\s+$/, ''));
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n');
};

export function registerTools(server: McpServer, d: ToolDeps) {
  const { mgr, guard, redactor, cfg, audit } = d;
  const L = cfg.limits;
  const sessionRef = z.string().min(1).describe('Session id (term_…) or the session name');
  const waitMs = (def: number) =>
    z.number().int().min(0).max(L.max_wait_ms).optional().describe(`How long to wait in this call, in ms (default ${def}, max ${L.max_wait_ms}). The process keeps running after the call returns.`);
  const maxBytes = z.number().int().min(256).max(L.max_read_bytes).optional().describe(`Max output bytes to return (default ${L.default_read_bytes})`);
  const approvalId = z.string().optional().describe('Approval ticket from an earlier APPROVAL_REQUIRED error, once the user approved it. Repeat the other arguments unchanged.');
  const envArg = z.record(z.string(), z.string()).optional().describe('Extra environment variables');
  const cwdArg = z.string().optional().describe('Working directory (absolute, ~ or relative to the default directory)');
  const clampWait = (v: number | undefined, def: number) => Math.min(v ?? def, L.max_wait_ms);

  const progress = (ctx: Ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    const notify = ctx.mcpReq.notify;
    if (token === undefined || !notify) return undefined;
    let n = 0;
    return (p: { elapsedMs: number; bytes: number }) => {
      void notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++n, message: `still running: ${Math.round(p.elapsedMs / 1000)}s, ${p.bytes} new bytes` },
      }).catch(() => undefined);
    };
  };

  const handle =
    <A>(tool: string, fn: (args: A, ctx: Ctx) => Promise<unknown>) =>
    async (args: A, ctx: unknown) => {
      try {
        return (await fn(args, ctx as Ctx)) as ToolResult;
      } catch (e) {
        if (e instanceof TerminalError && ['POLICY_DENIED', 'APPROVAL_REQUIRED', 'APPROVAL_DENIED'].includes(e.code)) {
          audit.write({ event: 'tool_blocked', tool, code: e.code, message: e.message });
        } else if (!(e instanceof TerminalError)) {
          audit.write({ event: 'tool_error', tool, message: (e as Error)?.message });
        }
        return fail(e);
      }
    };

  const readHint = (s: Session, r: Rendered, w?: WaitResult) => {
    if (r.has_more) return `more output is available: call terminal_read(session_id="${s.id}") again (cursor=${r.next_cursor})`;
    if (r.omitted) return `the middle of the output was omitted; page it with terminal_read(session_id="${s.id}", cursor=${r.omitted.from})`;
    if (!s.running) return undefined;
    if (w?.reason === 'timeout') return 'nothing matched yet and the process is still running; call terminal_read again to keep waiting';
    if (w?.reason === 'input_wait_likely') return `the program seems to be waiting for input (${w.activityReason}); reply with terminal_send`;
    return undefined;
  };

  // ───────────────────────────── terminal_run
  server.registerTool(
    'terminal_run',
    {
      title: 'Run a command',
      description:
        'Run one shell command non-interactively (no TTY, stdin closed unless given) and return stdout, stderr and the exit code. ' +
        'Best for short, self-contained commands. If it is still running when wait_ms elapses you get a session_id; continue with terminal_read(until=["exit"]). ' +
        'For interactive programs, REPLs, servers or several dependent commands, use terminal_create + terminal_exec instead.',
      inputSchema: z.object({
        command: z.string().min(1).describe('Shell command line (run with the login shell, e.g. zsh -l -c)'),
        cwd: cwdArg,
        env: envArg,
        stdin: z.string().optional().describe('Text written to stdin, which is then closed'),
        timeout_s: z.number().int().min(0).max(86_400).optional().describe(`Kill the command after this many seconds (default ${L.default_run_timeout_s}, 0 = no limit)`),
        wait_ms: waitMs(L.default_wait_ms),
        max_bytes: maxBytes,
        approval_id: approvalId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle('terminal_run', async (a: { command: string; cwd?: string; env?: Record<string, string>; stdin?: string; timeout_s?: number; wait_ms?: number; max_bytes?: number; approval_id?: string }, ctx) => {
      const cwd = mgr.resolveCwd(a.cwd);
      const g = await guard.check(ctx, { tool: 'terminal_run', args: a, command: a.command, cwd });
      if (!g.proceed) return g.result;
      const s = await mgr.create({ kind: 'command', mode: 'pipe', command: a.command, cwd, env: a.env, stdin: a.stdin });
      audit.write({ event: 'tool_call', tool: 'terminal_run', session_id: s.id, command: a.command, cwd, approved_by: g.approvedBy });
      const timeout = a.timeout_s ?? L.default_run_timeout_s;
      if (timeout > 0) {
        const t = setTimeout(() => {
          s.timedOut = true;
          void mgr.terminate(s, 2000);
        }, timeout * 1000);
        t.unref();
        s.once('exit', () => clearTimeout(t));
      }
      const w = await waitFor(s, [{ kind: 'exit' }], { from: 0, deadline: Date.now() + clampWait(a.wait_ms, L.default_wait_ms), signal: ctx.mcpReq.signal, onProgress: progress(ctx) });
      const mb = a.max_bytes ?? L.default_read_bytes;
      if (!s.running) {
        await new Promise((r) => setTimeout(r, 20));
        const out = renderRange(s, 0, s.endSeq, mb, 'text', redactor, (st) => st === 'stdout');
        const err = renderRange(s, 0, s.endSeq, Math.max(2048, Math.floor(mb / 2)), 'text', redactor, (st) => st === 'stderr');
        s.clientCursor = s.endSeq;
        const status = s.timedOut ? 'timed_out' : s.state === 'failed' ? 'failed' : s.exit?.signal ? 'killed' : 'exited';
        const duration = (s.exit?.at ?? Date.now()) - s.createdAt;
        const text = err.text.trim() ? `${out.text.trim() ? `${out.text.replace(/\n$/, '')}\n` : ''}[stderr]\n${err.text}` : body(out.text);
        return ok(
          {
            session_id: s.id,
            status,
            exit_code: s.exit?.code ?? undefined,
            signal: s.exit?.signal ?? undefined,
            error: s.exit?.error,
            duration_ms: duration,
            stdout: out.text,
            stderr: err.text,
            truncated: out.truncated || err.truncated || undefined,
          },
          `[${s.id} · ${status}${s.exit?.code !== null && s.exit?.code !== undefined ? ` · exit ${s.exit.code}` : ''}${s.exit?.signal ? ` · ${s.exit.signal}` : ''} · ${duration}ms]`,
          text,
          s.timedOut ? `killed after timeout_s=${timeout}; raise timeout_s or run it in a session (terminal_create)` : s.exit?.error ? 'the command could not be started' : undefined,
        );
      }
      const r = renderRange(s, 0, s.endSeq, mb, 'text', redactor);
      s.clientCursor = r.next_cursor;
      return ok(
        { session_id: s.id, status: 'running', pid: s.pid, output: r.text, next_cursor: r.next_cursor, waited_ms: w.waitedMs },
        `[${s.id} · running · ${w.waitedMs}ms so far]`,
        body(r.text),
        `still running; continue with terminal_read(session_id="${s.id}", until=["exit"]) or stop it with terminal_close`,
      );
    }),
  );

  // ───────────────────────────── terminal_create
  server.registerTool(
    'terminal_create',
    {
      title: 'Create a terminal session',
      description:
        'Start a persistent terminal session in a PTY: an interactive login shell (default) or a specific program (REPL, server, TUI). ' +
        'Returns session_id. Then use terminal_exec (shell commands), terminal_send (keystrokes/answers), terminal_read (output with cursors and waits) and finally terminal_close. ' +
        'Shell sessions keep cwd, env and background jobs between commands and report each command\'s exit code.',
      inputSchema: z.object({
        program: z.string().optional().describe('Program to run instead of a shell, e.g. "python3", "node", "npm"'),
        args: z.array(z.string()).optional().describe('Arguments for program'),
        shell: z.string().optional().describe('Shell to use for a shell session (default: the user\'s login shell)'),
        mode: z.enum(['pty', 'pipe']).optional().describe('pty (default) = real terminal; pipe = separate stdout/stderr without a TTY (program only)'),
        name: z.string().optional().describe('Optional unique name usable instead of session_id, e.g. "devserver"'),
        cwd: cwdArg,
        env: envArg,
        cols: z.number().int().min(20).max(1000).optional(),
        rows: z.number().int().min(5).max(500).optional(),
        idle_ttl_s: z.number().int().min(0).optional().describe(`Close automatically after this long without output or tool calls (default ${L.idle_ttl_s}, 0 = never)`),
        wait_ready_ms: z.number().int().min(0).max(30_000).optional().describe('How long to wait for the shell prompt or first program output (default 8000 for shells, 1500 for programs)'),
        approval_id: approvalId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle('terminal_create', async (a: { program?: string; args?: string[]; shell?: string; mode?: 'pty' | 'pipe'; name?: string; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number; idle_ttl_s?: number; wait_ready_ms?: number; approval_id?: string }, ctx) => {
      const cwd = mgr.resolveCwd(a.cwd);
      const isShell = !a.program;
      if (isShell && a.mode === 'pipe') throw new TerminalError('INVALID_ARGUMENT', 'mode "pipe" needs a program', 'omit mode for shell sessions');
      let approvedBy: string | undefined;
      if (!isShell) {
        const g = await guard.check(ctx, { tool: 'terminal_create', args: a, argv: [a.program!, ...(a.args ?? [])], cwd });
        if (!g.proceed) return g.result;
        approvedBy = g.approvedBy;
      }
      const s = await mgr.create({
        kind: isShell ? 'shell' : 'program',
        mode: a.mode ?? 'pty',
        program: isShell ? a.shell : a.program,
        args: a.args,
        cwd,
        env: a.env,
        name: a.name,
        cols: a.cols,
        rows: a.rows,
        idleTtlS: a.idle_ttl_s,
        keepStdinOpen: true,
      });
      audit.write({ event: 'tool_call', tool: 'terminal_create', session_id: s.id, command: s.displayCommand, cwd, approved_by: approvedBy });
      let ready = true;
      if (isShell) {
        ready = await waitReady(s, a.wait_ready_ms ?? 8000);
        if (!ready && s.running && s.integration === 'active') s.integration = 'degraded';
      } else {
        await waitStarted(s, a.wait_ready_ms ?? 1500, ctx.mcpReq.signal);
      }
      void mgr.track(s);
      const r = renderTail(s, 30, 'text', redactor);
      s.clientCursor = s.endSeq;
      const hint = !s.running
        ? `the process already ended (${fmtExit(s)}); read its output above`
        : isShell
          ? ready
            ? 'run commands with terminal_exec(session_id, command)'
            : 'the shell prompt was not detected (slow or unusual shell config); terminal_exec still works but completion detection uses a fallback'
          : 'interact with terminal_send(session_id, text, submit=true); read output with terminal_read(session_id, wait_ms=…)';
      return ok(
        {
          ...summary(s),
          integration: s.integration,
          ready,
          cursor: s.endSeq,
          output: r.text,
        },
        `${sessionTag(s, isShell ? `shell${ready ? ' ready' : ''}` : 'program')} cwd=${s.cwd} sandbox=${s.sandbox}`,
        r.text.trim() ? r.text : undefined,
        hint,
      );
    }),
  );

  // ───────────────────────────── terminal_exec
  server.registerTool(
    'terminal_exec',
    {
      title: 'Execute a command in a shell session',
      description:
        'Type a command into a shell session and wait until it finishes (detected via shell integration), returning only that command\'s output and its exit code. ' +
        'If it does not finish within wait_ms, status is "running" (or "awaiting_input" when it seems to wait for an answer): continue with terminal_read(until=["command_done"]) or answer with terminal_send. ' +
        'The shell must be at its prompt; one command at a time per session (use more sessions for parallel work).',
      inputSchema: z.object({
        session_id: sessionRef,
        command: z.string().min(1).describe('Command line; multi-line scripts are pasted as one unit'),
        wait_ms: waitMs(L.default_wait_ms),
        max_bytes: maxBytes,
        view: z.enum(['text', 'raw']).optional().describe('text (default): ANSI-stripped, progress bars collapsed; raw: keeps colors/escape sequences'),
        approval_id: approvalId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle('terminal_exec', async (a: { session_id: string; command: string; wait_ms?: number; max_bytes?: number; view?: 'text' | 'raw'; approval_id?: string }, ctx) => {
      const s = mgr.get(a.session_id);
      s.touch();
      if (s.kind === 'shell' && s.running && !s.ready && s.integration === 'active') {
        const ready = await waitReady(s, 5000);
        if (!ready && s.running) s.integration = 'degraded';
      }
      const g = await guard.check(ctx, { tool: 'terminal_exec', args: a, command: a.command, cwd: s.cwd, sessionId: s.id });
      if (!g.proceed) return g.result;
      const { cmd, startSeq } = startExec(s, a.command);
      audit.write({ event: 'tool_call', tool: 'terminal_exec', session_id: s.id, command_id: cmd.id, command: a.command, cwd: s.cwd, approved_by: g.approvedBy });
      const w = await waitFor(s, [{ kind: 'command_done' }, { kind: 'input' }], {
        from: startSeq,
        deadline: Date.now() + clampWait(a.wait_ms, L.default_wait_ms),
        signal: ctx.mcpReq.signal,
        commandId: cmd.id,
        inputMinQuietMs: 800,
        onProgress: progress(ctx),
      });
      void mgr.track(s);
      const mb = a.max_bytes ?? L.default_read_bytes;
      const view = a.view ?? 'text';
      const from = cmd.outputStart ?? startSeq;
      if (cmd.endSeq !== undefined) {
        const r = renderRange(s, from, cmd.endSeq, mb, view, redactor);
        s.clientCursor = Math.max(s.clientCursor, s.endSeq);
        const dur = (cmd.endedAt ?? Date.now()) - cmd.startedAt;
        return ok(
          { session_id: s.id, command_id: cmd.id, status: 'completed', exit_code: cmd.exitCode, duration_ms: dur, cwd: s.cwd, output: r.text, truncated: r.truncated, omitted: r.omitted },
          `[${s.id} · ${cmd.id} · exit ${cmd.exitCode ?? '?'} · ${dur}ms] cwd=${s.cwd}`,
          body(r.text),
          readHint(s, r),
        );
      }
      const r = renderRange(s, from, s.endSeq, mb, view, redactor);
      s.clientCursor = Math.max(s.clientCursor, r.next_cursor);
      if (!s.running) {
        return ok(
          { session_id: s.id, command_id: cmd.id, status: 'session_exited', exit_code: s.exit?.code ?? undefined, signal: s.exit?.signal ?? undefined, output: r.text },
          `[${s.id} · ${cmd.id} · session ${fmtExit(s)}]`,
          body(r.text),
          'the shell itself exited (e.g. "exit" or a crash); create a new session',
        );
      }
      const awaiting = w.reason === 'input_wait_likely';
      if (s.screen?.altScreen && !a.view) {
        const snap = await s.screen.snapshot();
        const lines = snap.lines.map((l) => redactor.redact(l).text);
        s.clientCursor = s.endSeq;
        return ok(
          { session_id: s.id, command_id: cmd.id, status: awaiting ? 'awaiting_input' : 'running', screen: { ...snap, lines }, next_cursor: s.endSeq },
          `[${s.id} · ${cmd.id} · full-screen program · screen ${snap.cols}x${snap.rows} cursor=${snap.cursor.y + 1}:${snap.cursor.x + 1}]`,
          screenText(lines),
          'a full-screen program is running (rendered screen shown); drive it with terminal_send(keys=[…], view="screen") and quit it to get back to the shell prompt',
        );
      }
      return ok(
        {
          session_id: s.id,
          command_id: cmd.id,
          status: awaiting ? 'awaiting_input' : 'running',
          activity_reason: w.activityReason,
          output: r.text,
          next_cursor: r.next_cursor,
          waited_ms: w.waitedMs,
        },
        `[${s.id} · ${cmd.id} · ${awaiting ? 'awaiting input' : 'running'} · ${w.waitedMs}ms]`,
        body(r.text),
        awaiting
          ? `it seems to wait for input (${w.activityReason}): answer with terminal_send(session_id="${s.id}", text=…, submit=true), or cancel with terminal_send(keys=["C-c"])`
          : `still running; continue with terminal_read(session_id="${s.id}", until=["command_done"], wait_ms=…) — output is kept, nothing is lost`,
      );
    }),
  );

  // ───────────────────────────── terminal_send
  server.registerTool(
    'terminal_send',
    {
      title: 'Send input to a session',
      description:
        'Write text and/or special keys to a session, e.g. answer a prompt, drive a REPL or TUI, or interrupt with keys=["C-c"]. ' +
        'submit=true presses Enter after the text. Returns the output produced in response (waits until output settles, up to wait_ms). ' +
        `Keys: ${'Enter, Tab, Escape, Backspace, Up/Down/Left/Right, Home/End, PageUp/PageDown, F1-F12, C-a..C-z (C-c interrupt, C-d EOF), M-x (Alt)'}. ` +
        'Use view="screen" to get the rendered screen for full-screen apps (vim, top, less).',
      inputSchema: z.object({
        session_id: sessionRef,
        text: z.string().optional().describe('Literal text to type (newlines are sent as Enter)'),
        keys: z.array(z.string()).optional().describe('Special keys sent after text, e.g. ["Down","Enter"] or ["C-c"]'),
        submit: z.boolean().optional().describe('Press Enter at the end (default false)'),
        wait_ms: waitMs(1500),
        max_bytes: maxBytes,
        view: z.enum(['text', 'raw', 'screen']).optional(),
        approval_id: approvalId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle('terminal_send', async (a: { session_id: string; text?: string; keys?: string[]; submit?: boolean; wait_ms?: number; max_bytes?: number; view?: 'text' | 'raw' | 'screen'; approval_id?: string }, ctx) => {
      if (!a.text && !a.keys?.length && !a.submit) throw new TerminalError('INVALID_ARGUMENT', 'nothing to send', 'pass text, keys or submit=true');
      const s = mgr.get(a.session_id);
      if (!s.running) throw new TerminalError('SESSION_EXITED', `session ${s.id} has ${s.state} (${fmtExit(s)})`, 'read its remaining output with terminal_read or create a new session');
      s.touch();
      const plan = planSend(s, a.text, a.keys, a.submit ?? false);
      let atShell = false;
      if (s.kind === 'shell') {
        if (s.integration === 'active') atShell = s.atPrompt;
        else atShell = !!(await s.foreground())?.isShell;
      }
      if (atShell && plan.submitted.length) {
        const g = await guard.check(ctx, { tool: 'terminal_send', args: a, command: plan.submitted.join('\n'), cwd: s.cwd, sessionId: s.id });
        if (!g.proceed) return g.result;
      }
      if (atShell && s.promptLine === undefined && !s.lineBuf && s.screen) {
        await s.screen.settle();
        s.promptLine = s.screen.cursorLine();
      }
      const start = s.endSeq;
      s.write(plan.payload);
      if (atShell) {
        s.lineBuf = plan.next.buf;
        s.lineUncertain = plan.next.uncertain;
      }
      audit.write({ event: 'tool_call', tool: 'terminal_send', session_id: s.id, text_bytes: a.text?.length ?? 0, keys: a.keys, submit: a.submit, submitted: atShell ? plan.submitted : undefined });
      const deadline = Date.now() + clampWait(a.wait_ms, 1500);
      const w1 = await waitFor(s, [{ kind: 'new_output' }], { from: start, deadline, signal: ctx.mcpReq.signal });
      let w = w1;
      if (w1.reason === 'new_output') {
        w = await waitFor(s, [{ kind: 'idle', ms: 300 }, { kind: 'input' }], { from: start, deadline, signal: ctx.mcpReq.signal, inputMinQuietMs: 300 });
      }
      void mgr.track(s);
      const act = await s.activity();
      if (a.view === 'screen' || (!a.view && s.screen?.altScreen)) {
        if (!s.screen) throw new TerminalError('NOT_SUPPORTED', 'screen view needs a pty session');
        const snap = await s.screen.snapshot();
        s.clientCursor = s.endSeq;
        const lines = snap.lines.map((l) => redactor.redact(l).text);
        return ok(
          { session_id: s.id, state: s.state, activity: act.activity, bytes_sent: Buffer.byteLength(plan.payload), screen: { ...snap, lines } },
          `${sessionTag(s, act.activity)} screen ${snap.cols}x${snap.rows} cursor=${snap.cursor.y + 1}:${snap.cursor.x + 1}${snap.alt_screen ? ' alt-screen' : ''}`,
          screenText(lines),
        );
      }
      const r = renderPage(s, start, a.max_bytes ?? L.default_read_bytes, a.view ?? 'text', redactor);
      s.clientCursor = Math.max(s.clientCursor, r.next_cursor);
      const finished = s.commands.filter((c) => c.endSeq !== undefined && c.endSeq >= start).pop();
      return ok(
        {
          session_id: s.id,
          state: s.state,
          activity: act.activity,
          activity_reason: act.reason,
          bytes_sent: Buffer.byteLength(plan.payload),
          output: r.text,
          cursor: r.cursor_from,
          next_cursor: r.next_cursor,
          has_more: r.has_more,
          exit_code: s.exit?.code ?? undefined,
          last_command: finished ? { command_id: finished.id, exit_code: finished.exitCode } : undefined,
        },
        `${sessionTag(s, act.activity)} sent ${Buffer.byteLength(plan.payload)} bytes · cursor ${r.cursor_from}→${r.next_cursor}${finished ? ` · ${finished.id} finished with exit ${finished.exitCode ?? '?'}` : ''}${w.reason === 'timeout' && w1.reason === 'timeout' ? ' · no output yet' : ''}`,
        body(r.text),
        readHint(s, r) ?? (act.activity === 'awaiting_input' ? 'waiting for more input' : undefined),
      );
    }),
  );

  // ───────────────────────────── terminal_read
  server.registerTool(
    'terminal_read',
    {
      title: 'Read session output',
      description:
        'Read output incrementally using byte cursors: omit cursor to continue where the last call stopped; pass next_cursor to page. ' +
        `Optionally block until a condition with until=[...] (${UNTIL_HELP}) or wait_ms for new output. ` +
        'view: text (default, ANSI stripped), raw (escape sequences kept), screen (rendered screen for TUIs). tail_lines returns just the last N lines.',
      inputSchema: z.object({
        session_id: sessionRef,
        cursor: z.number().int().min(0).optional().describe('Byte cursor to read from (default: where the previous call ended)'),
        max_bytes: maxBytes,
        view: z.enum(['text', 'raw', 'screen']).optional(),
        stream: z.enum(['both', 'stdout', 'stderr']).optional().describe('pipe-mode sessions only (default both)'),
        until: z.array(z.string()).optional().describe('Wait until any condition holds: "exit", "command_done", "input", "idle:<ms>", "pattern:<regex>"'),
        wait_ms: waitMs(0),
        tail_lines: z.number().int().min(1).max(2000).optional().describe('Return only the last N lines (ignores cursor)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle('terminal_read', async (a: { session_id: string; cursor?: number; max_bytes?: number; view?: 'text' | 'raw' | 'screen'; stream?: 'both' | 'stdout' | 'stderr'; until?: string[]; wait_ms?: number; tail_lines?: number }, ctx) => {
      const s = mgr.get(a.session_id);
      s.touch();
      const from = Math.min(a.cursor ?? s.clientCursor, s.endSeq);
      let w: WaitResult | undefined;
      let conds: UntilCond[] = parseUntil(a.until);
      let waitFor_ = a.wait_ms ?? 0;
      if (conds.length && a.wait_ms === undefined) waitFor_ = L.default_wait_ms;
      if (waitFor_ > 0 && s.running) {
        if (!conds.length) conds = [{ kind: 'new_output' }];
        // With an implicit cursor, a pattern may also match output of the current command
        // (or, for program sessions, of the whole session) that an earlier call already returned.
        let patternFrom: number | undefined;
        if (a.cursor === undefined && conds.some((c) => c.kind === 'pattern')) {
          const cur = s.commands.length ? s.commands[s.commands.length - 1] : undefined;
          patternFrom = s.kind === 'shell' ? (cur && cur.endSeq === undefined ? (cur.outputStart ?? cur.sentSeq) : from) : 0;
        }
        w = await waitFor(s, conds, { from, patternFrom, deadline: Date.now() + clampWait(waitFor_, 0), signal: ctx.mcpReq.signal, onProgress: progress(ctx) });
      }
      const lastCmd = s.commands.filter((c) => c.endSeq !== undefined && c.endSeq >= from).pop();
      const common = {
        session_id: s.id,
        state: s.state,
        exit_code: s.exit?.code ?? undefined,
        signal: s.exit?.signal ?? undefined,
        wait_reason: w?.reason,
        matched: w?.matched,
        waited_ms: w?.waitedMs,
        last_command: lastCmd ? { command_id: lastCmd.id, exit_code: lastCmd.exitCode } : undefined,
      };
      const waitNote = w ? ` · wait ${w.reason} after ${w.waitedMs}ms` : '';
      if (a.view === 'screen' || (!a.view && a.cursor === undefined && !a.tail_lines && s.running && s.screen?.altScreen)) {
        if (!s.screen) throw new TerminalError('NOT_SUPPORTED', 'screen view needs a live pty session', 'use view="text"');
        const snap = await s.screen.snapshot();
        const lines = snap.lines.map((l) => redactor.redact(l).text);
        s.clientCursor = s.endSeq;
        return ok(
          { ...common, screen: { ...snap, lines }, next_cursor: s.endSeq },
          `${sessionTag(s)} screen ${snap.cols}x${snap.rows} cursor=${snap.cursor.y + 1}:${snap.cursor.x + 1}${snap.alt_screen ? ' alt-screen' : ''}${waitNote}`,
          screenText(lines),
        );
      }
      if (a.stream && a.stream !== 'both' && s.mode !== 'pipe') throw new TerminalError('INVALID_ARGUMENT', 'stream selection needs a pipe-mode session', 'PTY sessions merge stdout and stderr; omit stream');
      const filter = a.stream && a.stream !== 'both' ? (st: string) => st === a.stream : undefined;
      const view = a.view ?? 'text';
      const r = a.tail_lines ? renderTail(s, a.tail_lines, view, redactor) : renderPage(s, from, a.max_bytes ?? L.default_read_bytes, view, redactor, filter);
      s.clientCursor = Math.max(s.clientCursor, r.next_cursor);
      const notes = [`cursor ${r.cursor_from}→${r.next_cursor}`];
      if (r.has_more) notes.push('more available');
      if (r.dropped_bytes) notes.push(`${r.dropped_bytes} older bytes no longer retained`);
      if (r.redactions) notes.push(`${r.redactions} secrets redacted`);
      return ok(
        { ...common, output: r.text, cursor: r.cursor_from, next_cursor: r.next_cursor, has_more: r.has_more, dropped_bytes: r.dropped_bytes || undefined },
        `${sessionTag(s, s.exit ? fmtExit(s) : undefined)} ${notes.join(' · ')}${waitNote}`,
        r.text.trim() ? r.text : r.has_more ? '' : '(no new output)',
        readHint(s, r, w) ?? (!s.running && !r.has_more ? `session ${fmtExit(s)}` : undefined),
      );
    }),
  );

  // ───────────────────────────── terminal_status
  server.registerTool(
    'terminal_status',
    {
      title: 'Session status',
      description: 'Detailed state of one session: running/exited, exit code, activity (busy / idle / awaiting_input) with the foreground process, current and recent commands, cwd and output cursors.',
      inputSchema: z.object({ session_id: sessionRef }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle('terminal_status', async (a: { session_id: string }) => {
      const s = mgr.get(a.session_id);
      const act = await s.activity();
      const data = {
        ...summary(s),
        activity: act.activity,
        activity_reason: act.reason,
        foreground: act.foreground ? { pgid: act.foreground.pgid, name: act.foreground.name, stat: act.foreground.stat } : undefined,
        integration: s.integration,
        ready: s.ready,
        at_prompt: s.atPrompt,
        current_command: s.current ? { command_id: s.current.id, command: s.current.text, running_ms: Date.now() - s.current.startedAt } : undefined,
        recent_commands: s.commands.slice(-5).map((c) => ({ command_id: c.id, command: c.text || '(typed)', exit_code: c.exitCode, done: c.endSeq !== undefined })),
        cursors: { earliest: s.earliestSeq, end: s.endSeq, last_read: s.clientCursor },
        output_rate_bps: s.outputRate,
        size: s.mode === 'pty' ? { cols: s.cols, rows: s.rows } : undefined,
        alt_screen: s.screen?.altScreen,
      };
      const lines = [
        `activity: ${act.activity} (${act.reason})`,
        `command: ${s.displayCommand}   cwd: ${s.cwd}   sandbox: ${s.sandbox}`,
        s.current ? `current: ${s.current.id} ${s.current.text || '(typed)'} for ${Math.round((Date.now() - s.current.startedAt) / 1000)}s` : undefined,
        `output: ${s.endSeq} bytes, unread ${Math.max(0, s.endSeq - s.clientCursor)}`,
      ].filter(Boolean);
      return ok(data, sessionTag(s, s.exit ? fmtExit(s) : act.activity), lines.join('\n'));
    }),
  );

  // ───────────────────────────── terminal_list
  server.registerTool(
    'terminal_list',
    {
      title: 'List sessions',
      description: 'List terminal sessions of this server (running and recently ended) with state, command, cwd and unread output.',
      inputSchema: z.object({ state: z.enum(['running', 'all']).optional().describe('Default all') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle('terminal_list', async (a: { state?: 'running' | 'all' }) => {
      const list = mgr.list(a.state !== 'running');
      const rows = list.map((s) => `${s.id}${s.name ? ` (${s.name})` : ''}  ${s.state}${s.exit ? ` ${fmtExit(s)}` : ''}  ${s.kind}/${s.mode}  ${s.cwd}  ${s.displayCommand.slice(0, 60)}  unread=${Math.max(0, s.endSeq - s.clientCursor)}`);
      return ok(
        { sessions: list.map(summary), running: mgr.runningCount(), max_sessions: L.max_sessions },
        `${list.length} session(s), ${mgr.runningCount()}/${L.max_sessions} running`,
        rows.join('\n') || '(none)',
      );
    }),
  );

  // ───────────────────────────── terminal_signal
  server.registerTool(
    'terminal_signal',
    {
      title: 'Send a signal',
      description: 'Send a POSIX signal to the foreground process group of a session (default) or to the whole session. Use SIGINT to interrupt, SIGTERM/SIGKILL to stop, SIGTSTP/SIGCONT to pause/resume.',
      inputSchema: z.object({
        session_id: sessionRef,
        signal: z.enum(SIGNALS),
        target: z.enum(['foreground', 'session']).optional().describe('foreground (default) = the job currently in front; session = every process of the session'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle('terminal_signal', async (a: { session_id: string; signal: (typeof SIGNALS)[number]; target?: 'foreground' | 'session' }) => {
      const s = mgr.get(a.session_id);
      if (!s.running) throw new TerminalError('SESSION_EXITED', `session ${s.id} has ${s.state}`);
      s.touch();
      let pgid = s.pgid!;
      let who = 'session';
      if ((a.target ?? 'foreground') === 'foreground' && s.mode === 'pty') {
        const fg = await s.foreground(0);
        if (fg) {
          pgid = fg.pgid;
          who = `foreground ${fg.name} (pgid ${fg.pgid})`;
        }
      }
      if (a.target === 'session') {
        for (const p of await s.ttyProcs()) signalGroup(p.pgid, a.signal);
      }
      const sent = signalGroup(pgid, a.signal);
      audit.write({ event: 'tool_call', tool: 'terminal_signal', session_id: s.id, signal: a.signal, target: who });
      await new Promise((r) => setTimeout(r, 300));
      const act = await s.activity();
      return ok(
        { session_id: s.id, signal: a.signal, target: who, delivered: sent, state: s.state, activity: act.activity, exit_code: s.exit?.code ?? undefined },
        `${sessionTag(s, act.activity)} ${a.signal} → ${who}${sent ? '' : ' (no such process)'}`,
      );
    }),
  );

  // ───────────────────────────── terminal_resize
  server.registerTool(
    'terminal_resize',
    {
      title: 'Resize terminal',
      description: 'Change the PTY size (columns x rows) of a session; full-screen programs redraw.',
      inputSchema: z.object({ session_id: sessionRef, cols: z.number().int().min(20).max(1000), rows: z.number().int().min(5).max(500) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle('terminal_resize', async (a: { session_id: string; cols: number; rows: number }) => {
      const s = mgr.get(a.session_id);
      if (s.mode !== 'pty' || !s.running) throw new TerminalError('NOT_SUPPORTED', 'only running pty sessions can be resized');
      s.backend!.resize(a.cols, a.rows);
      s.screen?.resize(a.cols, a.rows);
      s.cols = a.cols;
      s.rows = a.rows;
      return ok({ session_id: s.id, cols: a.cols, rows: a.rows }, `${sessionTag(s)} resized to ${a.cols}x${a.rows}`);
    }),
  );

  // ───────────────────────────── terminal_close
  server.registerTool(
    'terminal_close',
    {
      title: 'Close a session',
      description: 'Terminate a session and every process it started (SIGHUP/SIGTERM, then SIGKILL after grace_ms). Output stays readable unless keep_output=false.',
      inputSchema: z.object({
        session_id: sessionRef,
        grace_ms: z.number().int().min(0).max(30_000).optional().describe('Time to exit gracefully before SIGKILL (default 2000)'),
        keep_output: z.boolean().optional().describe('Keep output for later terminal_read (default true)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('terminal_close', async (a: { session_id: string; grace_ms?: number; keep_output?: boolean }) => {
      const s = mgr.get(a.session_id);
      const wasRunning = s.running;
      const res = await mgr.close(s, a.grace_ms ?? 2000, a.keep_output ?? true);
      return ok(
        { session_id: s.id, state: s.state, exit_code: s.exit?.code ?? undefined, signal: s.exit?.signal ?? undefined, signals_sent: res.signals, leftover_pids: res.leftover.length ? res.leftover : undefined },
        `${sessionTag(s, fmtExit(s))} ${wasRunning ? `closed (${res.signals.join(' → ') || 'no signal needed'})` : 'was already finished'}`,
        undefined,
        res.leftover.length ? `some processes did not exit: ${res.leftover.join(', ')}` : undefined,
      );
    }),
  );
}
