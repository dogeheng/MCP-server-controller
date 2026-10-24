import { homedir } from 'node:os';
import { basename, normalize } from 'node:path';
import type { Config, Decision, Rule } from '../config/schema.js';
import { expandHome, isWithin, realpathLoose } from '../util/paths.js';
import { parseCommand, type SimpleCommand } from './parser.js';

export interface Reason {
  decision: Decision;
  source: 'user' | 'builtin' | 'default' | 'parser';
  why: string;
  segment?: string;
  rule?: string;
}

export interface Verdict {
  decision: Decision;
  reasons: Reason[];
  segments: string[];
}

interface Segment {
  argv: string[];
  nameDynamic: boolean;
  argsDynamic: boolean;
}

const SEVERITY: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
const max = (a: Decision, b: Decision): Decision => (SEVERITY[b] > SEVERITY[a] ? b : a);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'xh']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'perl', 'ruby', 'node', 'php', 'bun', 'deno', 'osascript']);

function globRe(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 's');
}

export function ruleMatches(pattern: string, display: string): boolean {
  if (globRe(pattern).test(display)) return true;
  // "git push *" also matches a bare "git push".
  if (pattern.endsWith(' *') && globRe(pattern.slice(0, -2)).test(display)) return true;
  return false;
}

const CRITICAL = (() => {
  const h = homedir();
  const set = new Set([
    '/', '/*', '~', '~/', '~/*', '$HOME', '${HOME}', '$HOME/*', '${HOME}/*', h, `${h}/*`,
    '/Users', '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/Volumes', '/cores',
  ]);
  return set;
})();

function isCritical(target: string): boolean {
  let t = target.trim();
  if (t.length > 1) t = t.replace(/\/+$/, '');
  if (CRITICAL.has(t)) return true;
  if (t.startsWith('/') && !t.includes('*')) {
    const n = normalize(t).replace(/\/+$/, '') || '/';
    if (CRITICAL.has(n)) return true;
  }
  return false;
}

function shortFlags(args: string[]): string {
  return args.filter((a) => /^-[A-Za-z]/.test(a) && !a.startsWith('--')).map((a) => a.slice(1)).join('');
}

function stripWrappers(seg: Segment, depth: number, out: Segment[], notes: Reason[]) {
  let argv = seg.argv.slice();
  let argsDynamic = seg.argsDynamic;
  for (let guard = 0; guard < 10 && argv.length; guard++) {
    const name = basename(argv[0]!);
    if (seg.nameDynamic && guard === 0) break;
    if (name === 'timeout' || name === 'gtimeout') {
      let i = 1;
      while (argv[i]?.startsWith('-')) i += ['-s', '-k', '--signal', '--kill-after'].includes(argv[i]!) ? 2 : 1;
      argv = argv.slice(i + 1);
    } else if (name === 'nice') {
      let i = 1;
      if (argv[1] === '-n') i = 3;
      else if (/^-n?\d+$/.test(argv[1] ?? '')) i = 2;
      argv = argv.slice(i);
    } else if (name === 'nohup' || name === 'builtin' || name === 'noglob') {
      argv = argv.slice(1);
    } else if (name === 'time') {
      argv = argv.slice(argv[1] === '-p' ? 2 : 1);
    } else if (name === 'caffeinate') {
      let i = 1;
      while (argv[i]?.startsWith('-')) i += ['-t', '-w'].includes(argv[i]!) ? 2 : 1;
      argv = argv.slice(i);
    } else if (name === 'command') {
      if (argv[1] === '-v' || argv[1] === '-V') return; // lookup only
      argv = argv.slice(argv[1] === '-p' ? 2 : 1);
    } else if (name === 'exec') {
      let i = 1;
      while (argv[i]?.startsWith('-')) i += argv[i] === '-a' ? 2 : 1;
      argv = argv.slice(i);
    } else if (name === 'env') {
      let i = 1;
      for (;;) {
        const a = argv[i];
        if (a === undefined) break;
        if (a === '-i' || a === '-' || a === '--ignore-environment') i++;
        else if (a === '-u' || a === '--unset') i += 2;
        else if (a.startsWith('-u')) i++;
        else if (a === '-S' || a === '--split-string') {
          const script = argv[i + 1];
          if (script !== undefined) expandScript(script, argsDynamic, depth, out, notes, 'env -S');
          return;
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i++;
        else break;
      }
      argv = argv.slice(i);
    } else if (name === 'xargs') {
      let i = 1;
      while (argv[i]?.startsWith('-')) {
        const a = argv[i]!;
        i += ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '-J', '-R', '-S'].includes(a) ? 2 : 1;
      }
      argv = argv.slice(i);
      argsDynamic = true;
    } else if (SHELLS.has(name)) {
      let i = 1;
      let hasC = false;
      while (argv[i]?.startsWith('-') || argv[i]?.startsWith('+')) {
        const a = argv[i]!;
        if (!a.startsWith('--') && a.slice(1).includes('c')) hasC = true;
        i++;
        if (a === '-o' || a === '+o' || a === '-O' || a === '+O') i++;
        if (hasC) break;
      }
      if (!hasC) break;
      const script = argv[i];
      if (script === undefined) break;
      expandScript(script, argsDynamic, depth, out, notes, `${name} -c`);
      return;
    } else if (name === 'eval') {
      expandScript(argv.slice(1).join(' '), argsDynamic, depth, out, notes, 'eval');
      return;
    } else break;
  }
  if (argv.length) out.push({ argv, nameDynamic: seg.nameDynamic, argsDynamic });
}

function expandScript(script: string, dynamic: boolean, depth: number, out: Segment[], notes: Reason[], via: string) {
  if (dynamic) {
    notes.push({ decision: 'ask', source: 'parser', why: `${via} runs a dynamically built script that cannot be checked statically` });
    return;
  }
  if (depth >= 4) {
    notes.push({ decision: 'ask', source: 'parser', why: `${via} nesting is too deep to check` });
    return;
  }
  const parsed = parseCommand(script);
  if (parsed.parseError) notes.push({ decision: 'ask', source: 'parser', why: `could not parse the script passed to ${via}` });
  for (const c of parsed.commands) stripWrappers(c, depth + 1, out, notes);
  for (const p of parsed.pipelines) checkPipeline(p, notes);
}

function checkPipeline(members: SimpleCommand[], notes: Reason[]) {
  const names = members.map((m) => {
    const tmp: Segment[] = [];
    stripWrappers(m, 0, tmp, []);
    return tmp[0] ? basename(tmp[0].argv[0]!) : basename(m.argv[0] ?? '');
  });
  const d = names.findIndex((n) => DOWNLOADERS.has(n));
  if (d >= 0 && names.slice(d + 1).some((n) => INTERPRETERS.has(n))) {
    notes.push({ decision: 'ask', source: 'builtin', why: 'pipes downloaded content into an interpreter', segment: names.join(' | ') });
  }
}

function gitSub(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]!) ? 2 : 1;
  return { sub: args[i] ?? '', rest: args.slice(i + 1) };
}

/** Built-in guard rails. Returns undefined when no built-in rule applies. */
export function builtinCheck(seg: Segment): { decision: Decision; why: string } | undefined {
  const name = basename(seg.argv[0] ?? '');
  const args = seg.argv.slice(1);
  if (seg.nameDynamic) return { decision: 'ask', why: 'the command name is computed at runtime' };
  if (['sudo', 'su', 'doas', 'pkexec'].includes(name)) return { decision: 'deny', why: 'privilege escalation is not allowed' };
  if (/^(mkfs|newfs)/.test(name) || name === 'fdisk' || name === 'gpt') return { decision: 'deny', why: 'disk formatting/partitioning' };
  if (name === 'diskutil') {
    const a0 = (args[0] ?? '').toLowerCase();
    if (/^(erase|partitiondisk|secureerase|zerodisk|randomdisk|reformat)/.test(a0) || (a0 === 'apfs' && /delete|erase/i.test(args[1] ?? ''))) {
      return { decision: 'deny', why: 'destructive disk operation' };
    }
  }
  if (name === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) return { decision: 'deny', why: 'raw write to a device' };
  if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(name)) return { decision: 'deny', why: 'power state change' };
  if (name === 'csrutil' || name === 'nvram' || (name === 'spctl' && args.includes('--master-disable'))) {
    return { decision: 'deny', why: 'changes system security settings' };
  }
  if (name === 'rm' || name === 'trash' || name === 'srm') {
    const dd = args.indexOf('--');
    const opts = dd >= 0 ? args.slice(0, dd) : args.filter((a) => a.startsWith('-'));
    const targets = dd >= 0 ? args.slice(dd + 1) : args.filter((a) => !a.startsWith('-'));
    const sf = shortFlags(opts);
    const recursive = /[rR]/.test(sf) || opts.includes('--recursive');
    const force = sf.includes('f') || opts.includes('--force');
    if (recursive && targets.some(isCritical)) return { decision: 'deny', why: 'recursive delete of a critical path' };
    if (recursive && force) return { decision: 'ask', why: 'recursive forced delete' };
    if (recursive && seg.argsDynamic) return { decision: 'ask', why: 'recursive delete of dynamically computed paths' };
    return undefined;
  }
  if (['chmod', 'chown', 'chgrp'].includes(name) && (/R/.test(shortFlags(args)) || args.includes('--recursive'))) {
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.some(isCritical)) return { decision: 'deny', why: `recursive ${name} on a critical path` };
    return { decision: 'ask', why: `recursive ${name}` };
  }
  if (name === 'find' && (args.includes('-delete') || args.some((a, i) => (a === '-exec' || a === '-execdir') && /(^|\/)rm$/.test(args[i + 1] ?? '')))) {
    return { decision: 'ask', why: 'find that deletes files' };
  }
  if (name === 'git') {
    const { sub, rest } = gitSub(args);
    if (sub === 'push' && rest.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a === '--mirror' || a === '--delete' || a === '-d' || /^[+:]/.test(a) || /^-[a-zA-Z]*f/.test(a))) {
      return { decision: 'ask', why: 'force/delete push rewrites remote history' };
    }
    if (sub === 'reset' && rest.includes('--hard')) return { decision: 'ask', why: 'git reset --hard discards local changes' };
    if (sub === 'clean' && (rest.includes('--force') || /f/.test(shortFlags(rest)))) return { decision: 'ask', why: 'git clean deletes untracked files' };
    if (sub === 'branch' && (rest.includes('-D') || (rest.includes('--delete') && rest.includes('--force')))) return { decision: 'ask', why: 'force-deletes a branch' };
    if (sub === 'stash' && rest[0] === 'clear') return { decision: 'ask', why: 'drops all stashes' };
    if (sub === 'filter-branch' || sub === 'filter-repo') return { decision: 'ask', why: 'rewrites repository history' };
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && (sub === 'restore' || rest.includes('--'))) {
      return { decision: 'ask', why: 'discards all uncommitted changes' };
    }
    return undefined;
  }
  if (name === 'kill' && args.includes('-1')) return { decision: 'ask', why: 'signals every process you own' };
  if (name === 'killall' || name === 'pkill') return { decision: 'ask', why: 'kills processes by name' };
  if ((['npm', 'pnpm', 'yarn', 'bun'].includes(name) && args[0] === 'publish') || (name === 'cargo' && args[0] === 'publish') || (name === 'gem' && args[0] === 'push') || (name === 'twine' && args[0] === 'upload')) {
    return { decision: 'ask', why: 'publishes a package' };
  }
  if (name === 'docker' || name === 'podman') {
    const j = args.join(' ');
    if (/^(system|image|container|volume|network|builder) prune\b/.test(j) || /^volume rm\b/.test(j) || /^(rm|rmi)\b.*\s-[a-zA-Z]*f/.test(j) || args[0] === 'push') {
      return { decision: 'ask', why: `destructive or publishing ${name} command` };
    }
  }
  if (name === 'kubectl' && ['delete', 'drain', 'replace'].includes(args[0] ?? '')) return { decision: 'ask', why: `kubectl ${args[0]}` };
  if (name === 'crontab' && args.includes('-r')) return { decision: 'ask', why: 'removes the crontab' };
  if (name === 'launchctl' && ['load', 'unload', 'bootstrap', 'bootout', 'enable', 'disable'].includes(args[0] ?? '')) {
    return { decision: 'ask', why: 'changes launchd services (persistence)' };
  }
  if (name === 'security' && (/^(find-(generic|internet)-password)$/.test(args[0] ?? '') && (args.includes('-w') || args.includes('-g')) || ['dump-keychain', 'export', 'delete-keychain'].includes(args[0] ?? ''))) {
    return { decision: 'ask', why: 'reads or alters keychain secrets' };
  }
  if (name === 'osascript') return { decision: 'ask', why: 'AppleScript can control other applications' };
  if (name === 'defaults' && args[0] === 'delete') return { decision: 'ask', why: 'deletes preferences' };
  return undefined;
}

const FORK_BOMB = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/;

export class PolicyEngine {
  constructor(private cfg: Config) {}

  private userRules(cwd: string): Rule[] {
    const now = Date.now();
    return this.cfg.security.rules.filter((r) => {
      if (r.expires_at && !(Date.parse(r.expires_at) > now)) return false;
      if (r.cwd && !isWithin(realpathLoose(cwd), realpathLoose(expandHome(r.cwd)))) return false;
      return true;
    });
  }

  /** Evaluates a shell command line. */
  evaluateCommand(text: string, cwd: string): Verdict {
    const notes: Reason[] = [];
    if (FORK_BOMB.test(text)) notes.push({ decision: 'deny', source: 'builtin', why: 'fork bomb' });
    const parsed = parseCommand(text);
    if (parsed.parseError) notes.push({ decision: 'ask', source: 'parser', why: 'the command could not be fully parsed' });
    const segs: Segment[] = [];
    for (const c of parsed.commands) stripWrappers(c, 0, segs, notes);
    for (const p of parsed.pipelines) checkPipeline(p, notes);
    return this.judge(segs, notes, cwd);
  }

  /** Evaluates a direct program invocation (argv, no shell). */
  evaluateArgv(argv: string[], cwd: string): Verdict {
    const notes: Reason[] = [];
    const segs: Segment[] = [];
    stripWrappers({ argv, nameDynamic: false, argsDynamic: false }, 0, segs, notes);
    return this.judge(segs, notes, cwd);
  }

  private judge(segs: Segment[], notes: Reason[], cwd: string): Verdict {
    const rules = this.userRules(cwd);
    const reasons: Reason[] = [...notes];
    const displays: string[] = [];
    let decision: Decision = 'allow';
    for (const n of notes) decision = max(decision, n.decision);
    for (const s of segs) {
      const display = [basename(s.argv[0] ?? ''), ...s.argv.slice(1)].join(' ');
      displays.push(display);
      const userHits = rules.filter((r) => r.match.some((m) => ruleMatches(m, display)));
      const b = this.cfg.security.builtin_rules ? builtinCheck(s) : undefined;
      let d: Decision;
      if (userHits.length) {
        d = userHits.reduce<Decision>((acc, r) => max(acc, r.decision), 'allow');
        const top = userHits.find((r) => r.decision === d)!;
        reasons.push({ decision: d, source: 'user', why: top.reason ?? `matched rule ${JSON.stringify(top.match)}`, segment: display, rule: top.match.join(' | ') });
        // User rules may relax "ask" built-ins, but a built-in "deny" is a hard floor
        // (it can only be lifted by turning builtin_rules off entirely).
        if (b?.decision === 'deny' && d !== 'deny') {
          d = 'deny';
          reasons.push({ decision: 'deny', source: 'builtin', why: `${b.why} (built-in deny cannot be overridden by rules)`, segment: display });
        }
      } else {
        if (b) {
          d = b.decision;
          reasons.push({ decision: d, source: 'builtin', why: b.why, segment: display });
        } else {
          d = this.cfg.security.default_decision;
          if (d !== 'allow') reasons.push({ decision: d, source: 'default', why: `default decision is ${d}`, segment: display });
        }
      }
      decision = max(decision, d);
    }
    // A user allow rule that matched the whole command explicitly overrides parser uncertainty.
    return { decision, reasons, segments: displays };
  }
}
