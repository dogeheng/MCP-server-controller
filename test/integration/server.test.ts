import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = new URL('../..', import.meta.url).pathname;
const BIN = join(ROOT, 'dist/bin/mcp-terminal.js');

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent: any };

async function startServer(extra: string[] = [], clientOpts: Record<string, unknown> = {}) {
  const ws = realpathSync(mkdtempSync('/tmp/mcpt-it-ws-'));
  const state = mkdtempSync('/tmp/mcpt-it-state-');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--workspace', ws, '--state-dir', state, '--approval', 'cli', '--log-level', 'warn', ...extra],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'it', version: '1' }, clientOpts as never);
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as unknown as Result;
  return { client, call, ws, state, transport };
}

const text = (r: Result) => r.content.map((c) => c.text).join('\n');

describe('mcp-terminal over stdio', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    expect(existsSync(BIN), 'run `npm run build` first').toBe(true);
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.client.close();
  });

  it('lists the terminal tools with annotations', async () => {
    const { tools } = await srv.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['terminal_run', 'terminal_create', 'terminal_exec', 'terminal_send', 'terminal_read', 'terminal_status', 'terminal_list', 'terminal_signal', 'terminal_resize', 'terminal_close']),
    );
    const read = tools.find((t) => t.name === 'terminal_read')!;
    expect(read.annotations?.readOnlyHint).toBe(true);
  });

  it('terminal_run returns exit code and separate stderr', async () => {
    const r = await srv.call('terminal_run', { command: 'echo out; echo err >&2; exit 3' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.exit_code).toBe(3);
    expect(r.structuredContent.stdout).toContain('out');
    expect(r.structuredContent.stderr).toContain('err');
  });

  it('keeps shell state between terminal_exec calls and reports per-command exit codes', async () => {
    const c = await srv.call('terminal_create', { name: 'state' });
    const id = c.structuredContent.session_id;
    await srv.call('terminal_exec', { session_id: id, command: 'export FOO=bar; mkdir -p sub && cd sub' });
    const r = await srv.call('terminal_exec', { session_id: 'state', command: 'echo "$FOO"; pwd; false' });
    expect(r.structuredContent.exit_code).toBe(1);
    expect(r.structuredContent.output).toContain('bar');
    expect(r.structuredContent.cwd).toBe(join(srv.ws, 'sub'));
    await srv.call('terminal_close', { session_id: id });
  });

  it('detects programs waiting for input and accepts answers', async () => {
    const c = await srv.call('terminal_create', {});
    const id = c.structuredContent.session_id;
    const r = await srv.call('terminal_exec', { session_id: id, command: 'printf "Name? "; read n; echo "hello $n"' });
    expect(r.structuredContent.status).toBe('awaiting_input');
    const s = await srv.call('terminal_send', { session_id: id, text: 'Bob', submit: true });
    expect(text(s)).toContain('hello Bob');
    expect(s.structuredContent.last_command?.exit_code).toBe(0);
    await srv.call('terminal_close', { session_id: id });
  });

  it('detects python input() with a CJK prompt', async () => {
    const c = await srv.call('terminal_create', {});
    const id = c.structuredContent.session_id;
    const r = await srv.call('terminal_exec', { session_id: id, command: `python3 -c 'n = input("你的名字是？ "); print("你好", n)'`, wait_ms: 8000 });
    expect(r.structuredContent.status).toBe('awaiting_input');
    expect(r.structuredContent.waited_ms ?? 0).toBeLessThan(5000);
    const s = await srv.call('terminal_send', { session_id: id, text: '小明', submit: true });
    expect(text(s)).toContain('你好 小明');
    await srv.call('terminal_close', { session_id: id });
  });

  it('returns early for long tasks and continues with cursors without losing output', async () => {
    const c = await srv.call('terminal_create', {});
    const id = c.structuredContent.session_id;
    const r = await srv.call('terminal_exec', { session_id: id, command: 'for i in 1 2 3; do echo tick $i; sleep 0.6; done', wait_ms: 500 });
    expect(r.structuredContent.status).toBe('running');
    const r2 = await srv.call('terminal_read', { session_id: id, until: ['command_done'], wait_ms: 5000 });
    const all = `${r.structuredContent.output}${text(r2)}`;
    for (const n of [1, 2, 3]) expect(all).toContain(`tick ${n}`);
    // paging from cursor 0 replays everything
    const full = await srv.call('terminal_read', { session_id: id, cursor: 0, max_bytes: 65536 });
    expect(text(full)).toContain('tick 3');
    await srv.call('terminal_close', { session_id: id });
  });

  it('waits for a regex pattern (server readiness)', async () => {
    const c = await srv.call('terminal_create', { program: 'sh', args: ['-c', 'sleep 0.5; echo "listening on :4321"; sleep 30'] });
    const id = c.structuredContent.session_id;
    const r = await srv.call('terminal_read', { session_id: id, until: ['pattern:listening on :\\d+'], wait_ms: 5000 });
    expect(r.structuredContent.wait_reason).toBe('pattern');
    expect(r.structuredContent.matched).toContain('listening on :4321');
    const k = await srv.call('terminal_close', { session_id: id });
    expect(k.isError).toBeFalsy();
  });

  it('interrupts a running program with C-c', async () => {
    const c = await srv.call('terminal_create', {});
    const id = c.structuredContent.session_id;
    await srv.call('terminal_exec', { session_id: id, command: 'sleep 30', wait_ms: 300 });
    await srv.call('terminal_send', { session_id: id, keys: ['C-c'] });
    const r = await srv.call('terminal_exec', { session_id: id, command: 'echo back' });
    expect(r.structuredContent.output).toContain('back');
    await srv.call('terminal_close', { session_id: id });
  });

  it('confines writes to the workspace (Seatbelt)', async () => {
    const target = join(homedir(), `mcpt-should-not-exist-${Date.now()}`);
    const r = await srv.call('terminal_run', { command: `touch ${target}; echo rc=$?` });
    expect(r.structuredContent.stdout).not.toContain('rc=0');
    expect(existsSync(target)).toBe(false);
    const ok = await srv.call('terminal_run', { command: 'touch inside.txt && echo ok' });
    expect(ok.structuredContent.stdout).toContain('ok');
    expect(existsSync(join(srv.ws, 'inside.txt'))).toBe(true);
  });

  it('rejects working directories outside the allowed roots', async () => {
    const r = await srv.call('terminal_run', { command: 'pwd', cwd: '/usr' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('CWD_NOT_ALLOWED');
  });

  it('blocks privilege escalation and requires approval for destructive commands', async () => {
    const d = await srv.call('terminal_run', { command: 'sudo ls' });
    expect(d.structuredContent.error.code).toBe('POLICY_DENIED');
    const a = await srv.call('terminal_run', { command: 'mkdir -p b/x && rm -rf b' });
    expect(a.structuredContent.error.code).toBe('APPROVAL_REQUIRED');
    const id = a.structuredContent.error.approval_id;
    execFileSync(process.execPath, [join(ROOT, 'dist/bin/termctl.js'), '--state-dir', srv.state, 'approve', id]);
    const ok = await srv.call('terminal_run', { command: 'mkdir -p b/x && rm -rf b', approval_id: id });
    expect(ok.structuredContent.exit_code).toBe(0);
    const again = await srv.call('terminal_run', { command: 'mkdir -p b/x && rm -rf b', approval_id: id });
    expect(again.structuredContent.error.code).toBe('APPROVAL_INVALID');
  });

  it('redacts secrets in output', async () => {
    const r = await srv.call('terminal_run', { command: 'echo ghp"_"abcdefghijklmnopqrstuvwxyz0123456789AB' });
    expect(text(r)).not.toContain('ghp_abc');
    expect(text(r)).toContain('REDACTED');
  });

  it('kills the whole process tree on close', async () => {
    const c = await srv.call('terminal_create', {});
    const id = c.structuredContent.session_id;
    const r = await srv.call('terminal_exec', { session_id: id, command: '(sleep 300 &) ; nohup sleep 301 >/dev/null 2>&1 & echo started' });
    expect(r.structuredContent.output).toContain('started');
    await srv.call('terminal_close', { session_id: id });
    await new Promise((res) => setTimeout(res, 300));
    const left = execFileSync('/bin/sh', ['-c', 'pgrep -f "sleep 30[01]" || true'], { encoding: 'utf8' }).trim();
    expect(left).toBe('');
  });

  it('lists sessions and exposes status', async () => {
    const c = await srv.call('terminal_create', { name: 'lister' });
    const st = await srv.call('terminal_status', { session_id: 'lister' });
    expect(st.structuredContent.state).toBe('running');
    const l = await srv.call('terminal_list', {});
    expect(l.structuredContent.sessions.some((s: { session_id: string }) => s.session_id === c.structuredContent.session_id)).toBe(true);
    await srv.call('terminal_close', { session_id: 'lister' });
  });
});

describe('approvals through MCP elicitation', () => {
  it('asks the client when it supports elicitation (2026-07-28 protocol)', async () => {
    let asked = 0;
    const ws = realpathSync(mkdtempSync('/tmp/mcpt-it-ws-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, '--workspace', ws, '--state-dir', mkdtempSync('/tmp/mcpt-it-state-'), '--approval', 'elicit', '--log-level', 'warn'],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'it-elicit', version: '1' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } } as never);
    client.setRequestHandler('elicitation/create', async () => {
      asked++;
      return { action: 'accept', content: { decision: asked === 1 ? 'allow_once' : 'deny' } } as never;
    });
    await client.connect(transport);
    const ok = (await client.callTool({ name: 'terminal_run', arguments: { command: 'git reset --hard 2>/dev/null; echo done' } })) as unknown as Result;
    expect(ok.structuredContent.stdout).toContain('done');
    const no = (await client.callTool({ name: 'terminal_run', arguments: { command: 'git reset --hard 2>/dev/null; echo done2' } })) as unknown as Result;
    expect(no.structuredContent.error.code).toBe('APPROVAL_DENIED');
    expect(asked).toBe(2);
    await client.close();
  });
});
