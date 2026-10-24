import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as tomlStringify, parse as tomlParse } from 'smol-toml';
import { ensureDir } from '../util/paths.js';
import { newApprovalId, sha256, stableStringify } from '../util/ids.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'used' | 'expired';

export interface ApprovalRecord {
  id: string;
  digest: string;
  tool: string;
  summary: string;
  command?: string;
  cwd?: string;
  session_id?: string;
  reasons: string[];
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  decided_at?: string;
  decided_by?: string;
  always?: boolean;
}

/** Digest of the security-relevant tool arguments; an approval is only valid for identical arguments. */
export function argsDigest(tool: string, args: Record<string, unknown>): string {
  const { approval_id: _a, wait_ms: _w, max_bytes: _m, view: _v, ...rest } = args;
  return sha256(`${tool}\n${stableStringify(rest)}`);
}

export class ApprovalStore {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = ensureDir(join(stateDir, 'approvals'));
  }

  private path(id: string) {
    if (!/^apr_[a-z0-9]+$/.test(id)) throw new Error('invalid approval id');
    return join(this.dir, `${id}.json`);
  }

  private save(r: ApprovalRecord) {
    const p = this.path(r.id);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  create(input: Omit<ApprovalRecord, 'id' | 'status' | 'created_at' | 'expires_at'>, ttlS: number): ApprovalRecord {
    const now = Date.now();
    const r: ApprovalRecord = {
      ...input,
      id: newApprovalId(),
      status: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlS * 1000).toISOString(),
    };
    this.save(r);
    return r;
  }

  get(id: string): ApprovalRecord | undefined {
    try {
      const r = JSON.parse(readFileSync(this.path(id), 'utf8')) as ApprovalRecord;
      if ((r.status === 'pending' || r.status === 'approved') && Date.parse(r.expires_at) < Date.now()) r.status = 'expired';
      return r;
    } catch {
      return undefined;
    }
  }

  decide(id: string, approved: boolean, by: string, always = false): ApprovalRecord {
    const r = this.get(id);
    if (!r) throw new Error(`approval ${id} not found`);
    if (r.status !== 'pending') throw new Error(`approval ${id} is ${r.status}`);
    r.status = approved ? 'approved' : 'denied';
    r.decided_at = new Date().toISOString();
    r.decided_by = by;
    r.always = approved && always;
    this.save(r);
    return r;
  }

  /** Validates and consumes an approval for the given digest. */
  consume(id: string, digest: string): { ok: true; record: ApprovalRecord } | { ok: false; reason: string; record?: ApprovalRecord } {
    const r = this.get(id);
    if (!r) return { ok: false, reason: 'unknown approval_id' };
    if (r.digest !== digest) return { ok: false, reason: 'approval_id was issued for different arguments', record: r };
    if (r.status === 'pending') return { ok: false, reason: 'still pending: the user has not decided yet', record: r };
    if (r.status !== 'approved') return { ok: false, reason: `approval is ${r.status}`, record: r };
    r.status = 'used';
    this.save(r);
    return { ok: true, record: r };
  }

  list(status?: ApprovalStatus): ApprovalRecord[] {
    const out: ApprovalRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const r = this.get(f.slice(0, -5));
      if (r && (!status || r.status === status)) out.push(r);
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  prune(maxAgeMs = 24 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const r of this.list()) {
      if (Date.parse(r.created_at) < cutoff) {
        try {
          unlinkSync(this.path(r.id));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Persists an "always allow" rule for an exact command, scoped to a directory. */
export function persistAlwaysRule(configDir: string, command: string, cwd: string | undefined) {
  ensureDir(configDir);
  const file = join(configDir, 'approved-rules.toml');
  let doc: { rules?: unknown[] } = {};
  if (existsSync(file)) {
    try {
      doc = tomlParse(readFileSync(file, 'utf8')) as { rules?: unknown[] };
    } catch {
      doc = {};
    }
  }
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  rules.push({
    decision: 'allow',
    match: [command.replace(/\s+/g, ' ').trim()],
    reason: `approved by user on ${new Date().toISOString()}`,
    ...(cwd ? { cwd } : {}),
  });
  writeFileSync(file, `# Rules added by "always allow" approvals. Safe to edit.\n${tomlStringify({ rules })}\n`, { mode: 0o600 });
  return file;
}
