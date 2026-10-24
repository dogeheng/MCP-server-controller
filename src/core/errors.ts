export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXITED'
  | 'SESSION_BUSY'
  | 'SESSION_NOT_READY'
  | 'NAME_IN_USE'
  | 'QUOTA_EXCEEDED'
  | 'CWD_NOT_ALLOWED'
  | 'CWD_NOT_FOUND'
  | 'PROGRAM_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'SANDBOX_UNAVAILABLE'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_INVALID'
  | 'INVALID_ARGUMENT'
  | 'NOT_SUPPORTED'
  | 'CANCELLED'
  | 'INTERNAL';

export class TerminalError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
