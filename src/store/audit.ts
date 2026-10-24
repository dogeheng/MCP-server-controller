import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../util/paths.js';
import { sha256, stableStringify } from '../util/ids.js';

export interface AuditEvent {
  event: string;
  session_id?: string;
  tool?: string;
  [k: string]: unknown;
}

const GENESIS = '0'.repeat(64);

/**
 * Append-only JSONL audit log. Each server instance keeps its own hash chain
 * (seq + prev + hash), so concurrent servers sharing a state dir never break
 * each other's chain; `verifyAudit` recomputes every chain.
 */
export class AuditLog {
  private seq = 0;
  private prev = GENESIS;
  private dir: string;

  constructor(
    dirOrFile: string,
    private instance: string,
    private enabled = true,
  ) {
    this.dir = ensureDir(dirOrFile);
  }

  private file() {
    const d = new Date();
    return join(this.dir, `audit-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
  }

  write(e: AuditEvent) {
    if (!this.enabled) return;
    const rec: Record<string, unknown> = { ts: new Date().toISOString(), instance: this.instance, seq: ++this.seq, ...e, prev: this.prev };
    const hash = sha256(this.prev + stableStringify(rec));
    rec.hash = hash;
    this.prev = hash;
    try {
      appendFileSync(this.file(), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    } catch {
      /* never let auditing crash the server */
    }
  }
}

export interface VerifyResult {
  files: number;
  records: number;
  chains: number;
  errors: string[];
}

export function verifyAudit(dir: string): VerifyResult {
  const res: VerifyResult = { files: 0, records: 0, chains: 0, errors: [] };
  if (!existsSync(dir)) return res;
  const files = readdirSync(dir).filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  const chains = new Map<string, { seq: number; prev: string }>();
  for (const f of files) {
    res.files++;
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        res.errors.push(`${f}:${i + 1}: not valid JSON`);
        return;
      }
      res.records++;
      const inst = String(rec.instance);
      const st = chains.get(inst) ?? { seq: 0, prev: GENESIS };
      const { hash, ...body } = rec;
      if (body.prev !== st.prev) res.errors.push(`${f}:${i + 1}: chain break for ${inst} (prev hash mismatch)`);
      if (body.seq !== st.seq + 1) res.errors.push(`${f}:${i + 1}: sequence gap for ${inst} (expected ${st.seq + 1}, got ${body.seq})`);
      const expect = sha256(String(body.prev) + stableStringify(body));
      if (expect !== hash) res.errors.push(`${f}:${i + 1}: hash mismatch (record modified)`);
      chains.set(inst, { seq: Number(body.seq), prev: String(hash) });
    });
  }
  res.chains = chains.size;
  return res;
}
