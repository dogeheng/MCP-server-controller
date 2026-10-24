export interface RedactPattern {
  name: string;
  regex: string;
}

const BUILTIN: { name: string; re: RegExp; keepGroup?: number }[] = [
  { name: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { name: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'openai_or_anthropic_key', re: /\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{24,}\b/g },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
  { name: 'npm_token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer_token', re: /(\bAuthorization:\s*Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, keepGroup: 1 },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Redactor {
  private literals = new Set<string>();
  private literalRe: RegExp | undefined;
  private custom: { name: string; re: RegExp }[] = [];

  constructor(
    private enabled: boolean,
    literals: string[] = [],
    patterns: RedactPattern[] = [],
  ) {
    for (const l of literals) this.addLiteral(l);
    for (const p of patterns) {
      try {
        this.custom.push({ name: p.name, re: new RegExp(p.regex, 'g') });
      } catch {
        /* invalid user regex: ignore */
      }
    }
  }

  /** Registers a known secret value (e.g. the value of a stripped env var). Short values are ignored. */
  addLiteral(v: string | undefined) {
    if (!v || v.length < 8 || /^\s*$/.test(v)) return;
    if (this.literals.has(v)) return;
    this.literals.add(v);
    const sorted = [...this.literals].sort((a, b) => b.length - a.length).map(escapeRe);
    this.literalRe = new RegExp(sorted.join('|'), 'g');
  }

  redact(text: string): { text: string; count: number } {
    if (!this.enabled || !text) return { text, count: 0 };
    let count = 0;
    let out = text;
    if (this.literalRe) {
      out = out.replace(this.literalRe, () => {
        count++;
        return '[REDACTED:secret]';
      });
    }
    for (const p of BUILTIN) {
      out = out.replace(p.re, (...m: string[]) => {
        count++;
        return p.keepGroup ? `${m[p.keepGroup]}[REDACTED:${p.name}]` : `[REDACTED:${p.name}]`;
      });
    }
    for (const p of this.custom) {
      out = out.replace(p.re, () => {
        count++;
        return `[REDACTED:${p.name}]`;
      });
    }
    return { text: out, count };
  }
}
