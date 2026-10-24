import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 chars, no 0/1/l/o

export function randomId(len: number): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i]! & 31];
  return s;
}

export const newSessionId = () => `term_${randomId(10)}`;
export const newCommandId = () => `cmd_${randomId(8)}`;
export const newApprovalId = () => `apr_${randomId(10)}`;
export const newInstanceId = () => `inst_${randomId(8)}`;
export const newNonce = () => randomId(16);

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON (sorted keys) used for digests and the audit hash chain. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}
