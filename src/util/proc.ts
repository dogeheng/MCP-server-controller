import { execFile } from 'node:child_process';

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  stat: string;
  tty: string;
  comm: string;
}

function run(file: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // ps exits 1 when no process matched; treat as empty output.
      resolve(err && !stdout ? '' : String(stdout));
    });
  });
}

function parse(out: string, withTty: boolean): ProcInfo[] {
  const res: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const n = withTty ? 6 : 5;
    if (parts.length < n + 1) continue;
    const [pid, ppid, pgid, tpgid, stat] = parts;
    res.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      tpgid: Number(tpgid),
      stat: stat!,
      tty: withTty ? parts[5]! : '',
      comm: parts.slice(n).join(' '),
    });
  }
  return res;
}

/** All processes on the system (used for descendant walks during cleanup). */
export async function listAllProcesses(): Promise<ProcInfo[]> {
  const out = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,comm=']);
  return parse(out, true);
}

/** Processes whose controlling terminal is `tty` (e.g. "ttys012" or "/dev/ttys012"). */
export async function ttyProcesses(tty: string): Promise<ProcInfo[]> {
  const name = tty.replace(/^\/dev\//, '');
  const out = await run('/bin/ps', ['-t', name, '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,comm=']);
  return parse(out, false).map((p) => ({ ...p, tty: name }));
}

export async function processStartTime(pid: number): Promise<string | undefined> {
  const out = (await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).trim();
  return out || undefined;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

export function signalPid(pid: number, sig: NodeJS.Signals): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

export function groupAlive(pgid: number): boolean {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Collects `root` and all of its descendants from a process table snapshot. */
export function descendants(table: ProcInfo[], root: number): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of table) {
    const arr = byParent.get(p.ppid) ?? [];
    arr.push(p);
    byParent.set(p.ppid, arr);
  }
  const out: ProcInfo[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = table.find((p) => p.pid === pid);
    if (self) out.push(self);
    for (const c of byParent.get(pid) ?? []) stack.push(c.pid);
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
