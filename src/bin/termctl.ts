#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { ApprovalStore } from '../policy/approvals.js';
import { PolicyEngine } from '../policy/engine.js';
import { initParser } from '../policy/parser.js';
import { resolveSandbox, sandboxAvailable } from '../sandbox/seatbelt.js';
import { verifyAudit } from '../store/audit.js';
import { Registry } from '../store/registry.js';
import { fixNodePty } from '../util/node-pty-fix.js';
import { expandHome, realpathLoose } from '../util/paths.js';
import { descendants, isAlive, listAllProcesses, processStartTime, signalGroup, signalPid } from '../util/proc.js';
import { VERSION } from '../server.js';

const HELP = `termctl ${VERSION} — companion CLI for mcp-terminal

  termctl approvals                 List pending approval requests
  termctl approve <id> [--always]   Approve a request (--always: remember this exact command for that directory)
  termctl deny <id>                 Deny a request
  termctl sessions [--all]          Sessions recorded in the registry
  termctl cleanup                   Kill processes of sessions whose server is gone
  termctl check "<cmd>" [--cwd d]   Show the policy decision for a command
  termctl sandbox-profile [--cwd d] Print the generated Seatbelt profile
  termctl audit verify | tail [-n N]
  termctl config                    Effective configuration and its sources
  termctl doctor                    Environment self-check
  termctl client-config [--workspace d]  JSON snippet for MCP clients (Manus, Claude Desktop, …)
`;

const out = (s: string) => process.stdout.write(`${s}\n`);

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      always: { type: 'boolean' },
      all: { type: 'boolean' },
      cwd: { type: 'string' },
      workspace: { type: 'string' },
      n: { type: 'string', short: 'n' },
      config: { type: 'string' },
      'state-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) return out(HELP);
  const loaded = loadConfig({ configPath: values.config, stateDir: values['state-dir'], workspace: values.workspace });
  const { config: cfg, stateDir, configDir } = loaded;

  switch (cmd) {
    case 'approvals': {
      const list = new ApprovalStore(stateDir).list('pending');
      if (!list.length) return out('No pending approvals.');
      for (const r of list) out(`${r.id}  expires ${r.expires_at}\n  command: ${r.command}\n  cwd:     ${r.cwd}\n  reasons: ${r.reasons.join('; ')}\n`);
      return;
    }
    case 'approve':
    case 'deny': {
      const id = rest[0];
      if (!id) throw new Error(`usage: termctl ${cmd} <approval_id>`);
      const store = new ApprovalStore(stateDir);
      const r = store.get(id);
      if (!r) throw new Error(`approval ${id} not found`);
      out(`command: ${r.command}\ncwd:     ${r.cwd}\nreasons: ${r.reasons.join('; ')}`);
      const d = store.decide(id, cmd === 'approve', `termctl:${process.env.USER ?? 'user'}`, !!values.always);
      out(`→ ${d.status}${d.always ? ' (always for this command in this directory)' : ''}. The agent can now retry with approval_id="${id}".`);
      return;
    }
    case 'sessions': {
      const reg = new Registry(stateDir);
      const rows = values.all ? reg.recent(0) : reg.byState(['running', 'starting']);
      if (!rows.length) out(values.all ? 'No sessions recorded.' : 'No running sessions.');
      for (const r of rows) {
        out(`${r.id}  ${r.state.padEnd(7)}  pid=${r.pid ?? '-'}  ${r.kind}/${r.mode}/${r.sandbox}  ${r.cwd}  ${r.command.slice(0, 60)}${r.exit_code !== null ? `  exit=${r.exit_code}` : ''}`);
      }
      const inst = reg.instances();
      out(`\nserver instances: ${inst.map((i) => `${i.id} pid=${i.pid}${isAlive(i.pid) ? '' : ' (dead)'} ${i.client ?? ''}`).join(', ') || 'none'}`);
      reg.close();
      return;
    }
    case 'cleanup': {
      const reg = new Registry(stateDir);
      const live = new Set<string>();
      for (const i of reg.instances()) {
        if (isAlive(i.pid) && (!i.pid_start || (await processStartTime(i.pid)) === i.pid_start)) live.add(i.id);
        else reg.removeInstance(i.id);
      }
      let n = 0;
      for (const r of reg.byState(['running', 'starting'])) {
        if (live.has(r.instance)) continue;
        if (r.pid && isAlive(r.pid) && (await processStartTime(r.pid)) === r.pid_start) {
          const tree = descendants(await listAllProcesses(), r.pid);
          if (r.pgid) signalGroup(r.pgid, 'SIGKILL');
          for (const p of tree) signalPid(p.pid, 'SIGKILL');
          n++;
        }
        reg.update(r.id, { state: 'lost', ended_at: Date.now() });
      }
      out(`cleaned up ${n} orphaned session(s).`);
      reg.close();
      return;
    }
    case 'check': {
      const command = rest.join(' ');
      if (!command) throw new Error('usage: termctl check "<command>"');
      await initParser();
      const cwd = realpathLoose(expandHome(values.cwd ?? process.cwd()));
      const v = new PolicyEngine(cfg).evaluateCommand(command, cwd);
      out(`decision: ${v.decision}`);
      for (const r of v.reasons) out(`  - ${r.decision} (${r.source}) ${r.why}${r.segment ? ` [${r.segment}]` : ''}`);
      out(`segments: ${v.segments.join('  |  ') || '(none)'}`);
      return;
    }
    case 'sandbox-profile': {
      const cwd = realpathLoose(expandHome(values.cwd ?? cfg.security.default_cwd ?? process.cwd()));
      const sd = stateDir;
      const sb = cfg.security.sandbox;
      const r = resolveSandbox(
        {
          allowWrite: sb.allow_write,
          denyRead: sb.deny_read,
          network: sb.network,
          extraRules: sb.extra_rules,
          protectedWrite: [sd, configDir],
          protectedRead: [join(sd, 'sessions'), join(sd, 'approvals'), join(sd, 'audit'), join(sd, 'registry.sqlite'), configDir],
        },
        cwd,
      );
      out(r.profile);
      process.stderr.write(`\n# writable: ${r.writable.join(', ')}\n`);
      return;
    }
    case 'audit': {
      const dir = cfg.audit.path ? expandHome(cfg.audit.path) : join(stateDir, 'audit');
      if (rest[0] === 'verify') {
        const v = verifyAudit(dir);
        out(`${v.records} records in ${v.files} file(s), ${v.chains} chain(s): ${v.errors.length ? 'TAMPERING OR CORRUPTION DETECTED' : 'OK'}`);
        for (const e of v.errors.slice(0, 50)) out(`  ${e}`);
        process.exitCode = v.errors.length ? 1 : 0;
        return;
      }
      const n = Number(values.n ?? 20);
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() : [];
      const lines = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
      for (const l of lines.slice(-n)) {
        const r = JSON.parse(l);
        const { ts, event, session_id, tool, command, decision, prev: _p, hash: _h, instance: _i, seq: _s, ...more } = r;
        out(`${ts} ${event}${tool ? ` ${tool}` : ''}${session_id ? ` ${session_id}` : ''}${decision ? ` ${decision}` : ''}${command ? `  $ ${String(command).slice(0, 100)}` : ''}${Object.keys(more).length ? `  ${JSON.stringify(more).slice(0, 160)}` : ''}`);
      }
      return;
    }
    case 'config':
      out(JSON.stringify({ sources: loaded.sources, warnings: loaded.warnings, configDir, stateDir, config: cfg }, null, 2));
      return;
    case 'doctor': {
      const ok = (b: boolean, label: string, extra = '') => out(`${b ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
      const [maj, min] = process.versions.node.split('.').map(Number);
      ok(maj! > 22 || (maj === 22 && min! >= 13), `Node.js ${process.versions.node}`, 'need >= 22.13 (node:sqlite)');
      ok(process.platform === 'darwin', `platform ${process.platform}/${process.arch}`);
      ok(sandboxAvailable(), 'sandbox-exec available');
      const fixed = fixNodePty();
      ok(true, 'node-pty spawn-helper permissions', fixed.length ? `fixed ${fixed.length} file(s)` : 'ok');
      try {
        const pty = await import('node-pty');
        const p = pty.spawn('/bin/echo', ['pty-ok'], { cols: 80, rows: 24 });
        const got = await new Promise<string>((res) => {
          let s = '';
          p.onData((d) => (s += d));
          p.onExit(() => res(s));
          setTimeout(() => res(s), 3000);
        });
        ok(got.includes('pty-ok'), 'PTY spawn works');
      } catch (e) {
        ok(false, 'PTY spawn works', (e as Error).message);
      }
      try {
        await initParser();
        ok(true, 'bash parser (tree-sitter WASM) loads');
      } catch (e) {
        ok(false, 'bash parser loads', (e as Error).message);
      }
      ok(!!process.env.SHELL, `login shell ${process.env.SHELL ?? '(unset, will use /bin/zsh)'}`);
      ok(true, `profile=${cfg.security.profile} network=${cfg.security.sandbox.network} approval=${cfg.security.approval.mode}`);
      ok(true, `roots: ${cfg.security.allowed_roots.join(', ')}`);
      ok(true, `state dir ${stateDir}`);
      return;
    }
    case 'client-config': {
      const here = dirname(fileURLToPath(import.meta.url));
      const entry = resolve(here, 'mcp-terminal.js');
      const args = [entry];
      if (values.workspace) args.push('--workspace', realpathLoose(expandHome(values.workspace)));
      out(JSON.stringify({ mcpServers: { terminal: { command: process.execPath, args } } }, null, 2));
      return;
    }
    default:
      out(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(`termctl: ${(e as Error).message}\n`);
  process.exit(1);
});
