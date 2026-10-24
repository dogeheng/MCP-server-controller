#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig, type CliOverrides } from '../config/load.js';
import { buildServer, createRuntime, shutdownRuntime, VERSION } from '../server.js';
import { log, setLogLevel } from '../util/log.js';

const HELP = `mcp-terminal ${VERSION} — MCP server for local terminal sessions (macOS, stdio)

Usage: mcp-terminal [options]

  --workspace <dir>       Confine sessions to <dir> (allowed root + default cwd)
  --root <dir>            Allowed root for session cwd (repeatable; replaces defaults)
  --cwd <dir>             Default working directory
  --allow-write <dir>     Extra writable directory inside the sandbox (repeatable)
  --deny-read <path>      Extra unreadable path inside the sandbox (repeatable)
  --network <mode>        allow | localhost | deny        (default allow)
  --profile <p>           workspace (Seatbelt sandbox, default) | host (no sandbox)
  --no-sandbox            Same as --profile host
  --approval <mode>       auto | elicit | dialog | cli | deny  (default auto)
  --default-wait-ms <n>   Default wait for run/exec (ms)
  --config <file>         Extra TOML config file (after ~/.config/mcp-terminal/config.toml)
  --state-dir <dir>       State directory (default ~/.local/state/mcp-terminal)
  --no-project-config     Ignore .mcp-terminal.toml in the default cwd
  --log-level <lvl>       debug | info | warn | error (stderr only)
  --print-config          Print the effective configuration and exit
  -v, --version / -h, --help
`;

function parseCli(): { overrides: CliOverrides; printConfig: boolean } {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      root: { type: 'string', multiple: true },
      cwd: { type: 'string' },
      'allow-write': { type: 'string', multiple: true },
      'deny-read': { type: 'string', multiple: true },
      network: { type: 'string' },
      profile: { type: 'string' },
      'no-sandbox': { type: 'boolean' },
      approval: { type: 'string' },
      'default-wait-ms': { type: 'string' },
      config: { type: 'string' },
      'state-dir': { type: 'string' },
      'no-project-config': { type: 'boolean' },
      'log-level': { type: 'string' },
      'print-config': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stderr.write(HELP);
    process.exit(0);
  }
  if (values.version) {
    process.stderr.write(`${VERSION}\n`);
    process.exit(0);
  }
  const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], name: string): T | undefined => {
    if (v === undefined) return undefined;
    if (!allowed.includes(v as T)) {
      process.stderr.write(`invalid --${name} "${v}" (expected ${allowed.join(' | ')})\n`);
      process.exit(2);
    }
    return v as T;
  };
  if (values['log-level']) setLogLevel(oneOf(values['log-level'], ['debug', 'info', 'warn', 'error'] as const, 'log-level')!);
  const overrides: CliOverrides = {
    configPath: values.config,
    workspace: values.workspace,
    roots: values.root,
    defaultCwd: values.cwd,
    allowWrite: values['allow-write'],
    denyRead: values['deny-read'],
    network: oneOf(values.network, ['allow', 'localhost', 'deny'] as const, 'network'),
    profile: values['no-sandbox'] ? 'host' : oneOf(values.profile, ['workspace', 'host'] as const, 'profile'),
    approval: oneOf(values.approval, ['auto', 'elicit', 'dialog', 'cli', 'deny'] as const, 'approval'),
    defaultWaitMs: values['default-wait-ms'] ? Number(values['default-wait-ms']) : undefined,
    stateDir: values['state-dir'],
    projectConfig: values['no-project-config'] ? false : undefined,
  };
  return { overrides, printConfig: !!values['print-config'] };
}

async function main() {
  if (process.platform !== 'darwin') {
    process.stderr.write('mcp-terminal currently supports macOS only\n');
    process.exit(1);
  }
  const { overrides, printConfig } = parseCli();
  const loaded = loadConfig(overrides);
  if (printConfig) {
    process.stdout.write(`${JSON.stringify({ sources: loaded.sources, warnings: loaded.warnings, stateDir: loaded.stateDir, configDir: loaded.configDir, config: loaded.config }, null, 2)}\n`);
    return;
  }
  const rt = await createRuntime(loaded);
  const handle = serveStdio(() => buildServer(rt), { onerror: (e) => log.warn('transport error', e) });
  log.info(`ready (pid ${process.pid}, profile ${rt.cfg.security.profile}, network ${rt.cfg.security.sandbox.network}, state ${rt.stateDir})`);

  let stopping = false;
  const stop = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(code), 6000);
    force.unref();
    await shutdownRuntime(rt, reason);
    await handle.close().catch(() => undefined);
    process.exit(code);
  };
  process.stdin.on('end', () => void stop('stdin closed'));
  process.stdin.on('close', () => void stop('stdin closed'));
  process.stdout.on('error', () => void stop('stdout closed'));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void stop(sig));
  // If the client dies without closing stdin we get re-parented to launchd (ppid 1).
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) void stop('parent process exited');
  }, 2000).unref();
  process.on('uncaughtException', (e) => log.error('uncaught exception', e));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
}

main().catch((e) => {
  log.error('fatal', e);
  process.exit(1);
});
