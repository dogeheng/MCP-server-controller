import { randomBytes } from 'node:crypto';
import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, createRequestStateCodec, inputRequired } from '@modelcontextprotocol/server';
import type { Config } from '../config/schema.js';
import { TerminalError } from '../core/errors.js';
import { ApprovalStore, argsDigest, persistAlwaysRule } from '../policy/approvals.js';
import { askWithDialog } from '../policy/dialog.js';
import type { PolicyEngine, Verdict } from '../policy/engine.js';
import type { AuditLog } from '../store/audit.js';

export interface Ctx {
  mcpReq: {
    signal: AbortSignal;
    _meta?: { progressToken?: string | number };
    notify?: (n: unknown) => Promise<void>;
    inputResponses?: unknown;
    requestState?: <T>() => T | undefined;
    envelope?: Record<string, unknown>;
  };
}

export interface GuardInput {
  tool: string;
  args: Record<string, unknown>;
  command?: string;
  argv?: string[];
  cwd: string;
  sessionId?: string;
}

export type GuardOutcome =
  | { proceed: true; verdict?: Verdict; approvedBy?: string }
  | { proceed: false; result: unknown };

interface ApprovalState {
  digest: string;
}

export class Guard {
  readonly codec = createRequestStateCodec<ApprovalState>({ key: randomBytes(32), ttlSeconds: 900 });

  constructor(
    private cfg: Config,
    private configDir: string,
    private policy: PolicyEngine,
    private approvals: ApprovalStore,
    private audit: AuditLog,
    private clientCaps: () => Record<string, unknown> | undefined,
  ) {}

  private supportsElicitation(ctx: Ctx): boolean {
    const modern = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown> | undefined;
    const caps = modern ?? this.clientCaps();
    const el = caps?.elicitation as Record<string, unknown> | undefined;
    if (!el) return false;
    // An empty object means form mode for older clients.
    return Object.keys(el).length === 0 || 'form' in el;
  }

  async check(ctx: Ctx, input: GuardInput): Promise<GuardOutcome> {
    const verdict = input.command !== undefined
      ? this.policy.evaluateCommand(input.command, input.cwd)
      : input.argv
        ? this.policy.evaluateArgv(input.argv, input.cwd)
        : undefined;
    if (!verdict || verdict.decision === 'allow') return { proceed: true, verdict };
    const what = input.command ?? input.argv?.join(' ') ?? '';
    const reasons = verdict.reasons.filter((r) => r.decision !== 'allow').map((r) => (r.segment ? `${r.why} [${r.segment}]` : r.why));
    this.audit.write({ event: 'policy', tool: input.tool, session_id: input.sessionId, decision: verdict.decision, command: what, cwd: input.cwd, reasons });

    if (verdict.decision === 'deny') {
      throw new TerminalError('POLICY_DENIED', `blocked by policy: ${reasons.join('; ')}`, 'this command is not allowed in this environment; choose a safer alternative or ask the user to run it themselves', { command: what });
    }

    const digest = argsDigest(input.tool, input.args);
    const approvalId = input.args.approval_id;
    if (typeof approvalId === 'string' && approvalId) {
      const c = this.approvals.consume(approvalId, digest);
      if (c.ok) {
        if (c.record.always) persistAlwaysRule(this.configDir, what, input.cwd);
        this.audit.write({ event: 'approval_used', tool: input.tool, approval_id: approvalId, session_id: input.sessionId, by: c.record.decided_by, always: c.record.always });
        return { proceed: true, verdict, approvedBy: `ticket:${approvalId}` };
      }
      if (c.record?.status === 'pending') {
        throw new TerminalError('APPROVAL_REQUIRED', `approval ${approvalId} is still pending`, `ask the user to run: termctl approve ${approvalId}   (or deny it with: termctl deny ${approvalId}), then call this tool again with the same arguments`, { approval_id: approvalId });
      }
      if (c.record?.status === 'denied') throw new TerminalError('APPROVAL_DENIED', 'the user denied this command', 'do not retry; choose another approach or ask the user', { approval_id: approvalId });
      throw new TerminalError('APPROVAL_INVALID', c.reason, 'call the tool again without approval_id to request a new approval');
    }

    // Second round of an MCP elicitation (multi round-trip request).
    const state = ctx.mcpReq.requestState?.<ApprovalState>();
    if (state && state.digest === digest) {
      const resp = acceptedContent<{ decision?: string }>(ctx.mcpReq.inputResponses as Record<string, unknown> | undefined, 'approval');
      const decision = resp?.decision;
      this.audit.write({ event: 'approval_decided', tool: input.tool, via: 'elicitation', decision: decision ?? 'declined', session_id: input.sessionId, command: what });
      if (decision === 'allow_once' || decision === 'allow_always') {
        if (decision === 'allow_always') persistAlwaysRule(this.configDir, what, input.cwd);
        return { proceed: true, verdict, approvedBy: 'elicitation' };
      }
      throw new TerminalError('APPROVAL_DENIED', 'the user denied this command', 'do not retry; choose another approach or ask the user');
    }

    const mode = this.cfg.security.approval.mode;
    if (mode === 'deny') {
      throw new TerminalError('POLICY_DENIED', `needs approval (${reasons.join('; ')}) but approvals are disabled`, 'choose a safer alternative');
    }
    const message = `Agent 请求执行需要审批的命令 / approval required\n\n命令: ${what}\n目录: ${input.cwd}\n原因: ${reasons.join('; ')}`;

    if ((mode === 'auto' || mode === 'elicit') && this.supportsElicitation(ctx)) {
      this.audit.write({ event: 'approval_requested', tool: input.tool, via: 'elicitation', session_id: input.sessionId, command: what });
      return {
        proceed: false,
        result: inputRequired({
          inputRequests: {
            approval: inputRequired.elicit({
              message,
              requestedSchema: {
                type: 'object',
                properties: {
                  decision: {
                    type: 'string',
                    title: '决定 / Decision',
                    description: 'allow_once = 仅本次允许, allow_always = 以后在该目录总是允许此命令, deny = 拒绝',
                    enum: ['allow_once', 'allow_always', 'deny'],
                  },
                },
                required: ['decision'],
              },
            }),
          },
          requestState: await this.codec.mint({ digest }),
        }),
      };
    }

    if (mode === 'auto' || mode === 'dialog') {
      this.audit.write({ event: 'approval_requested', tool: input.tool, via: 'dialog', session_id: input.sessionId, command: what });
      const r = await askWithDialog(message, this.cfg.security.approval.dialog_timeout_s);
      if (r === 'allow_once' || r === 'allow_always') {
        if (r === 'allow_always') persistAlwaysRule(this.configDir, what, input.cwd);
        this.audit.write({ event: 'approval_decided', tool: input.tool, via: 'dialog', decision: r, session_id: input.sessionId, command: what });
        return { proceed: true, verdict, approvedBy: 'dialog' };
      }
      if (r === 'deny') {
        this.audit.write({ event: 'approval_decided', tool: input.tool, via: 'dialog', decision: 'deny', session_id: input.sessionId, command: what });
        throw new TerminalError('APPROVAL_DENIED', 'the user denied this command in the approval dialog', 'do not retry; choose another approach or ask the user');
      }
      // timeout or no GUI: fall back to an out-of-band ticket.
    }

    const rec = this.approvals.create(
      { digest, tool: input.tool, summary: what, command: what, cwd: input.cwd, session_id: input.sessionId, reasons },
      this.cfg.security.approval.ttl_s,
    );
    this.audit.write({ event: 'approval_requested', tool: input.tool, via: 'ticket', approval_id: rec.id, session_id: input.sessionId, command: what });
    throw new TerminalError(
      'APPROVAL_REQUIRED',
      `this command needs the user's approval: ${reasons.join('; ')}`,
      `tell the user to run "termctl approve ${rec.id}" (or "termctl deny ${rec.id}") in their own terminal, then call this tool again with the same arguments plus approval_id="${rec.id}". The approval expires at ${rec.expires_at}.`,
      { approval_id: rec.id, command: what, cwd: input.cwd, expires_at: rec.expires_at },
    );
  }
}
