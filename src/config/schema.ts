import * as z from 'zod/v4';

export const DecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type Decision = z.infer<typeof DecisionSchema>;

export const RuleSchema = z.object({
  decision: DecisionSchema,
  match: z.array(z.string().min(1)).min(1),
  reason: z.string().optional(),
  /** Only apply when the session cwd is inside this directory. */
  cwd: z.string().optional(),
  /** ISO timestamp after which the rule is ignored. */
  expires_at: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const DEFAULT_DENY_READ = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gh',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.kube/config',
  '~/Library/Keychains',
];

export const DEFAULT_ALLOW_WRITE = ['{cwd}', '/tmp', '{tmpdir}', '{darwin_cache}'];

export const DEFAULT_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_*', 'TZ', 'TMPDIR', 'EDITOR', 'VISUAL', 'PAGER',
  'XDG_*', 'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY', 'NVM_DIR', 'NVM_BIN', 'PYENV_ROOT',
  'GOPATH', 'GOROOT', 'JAVA_HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'SDKMAN_DIR', 'VOLTA_HOME', 'BUN_INSTALL',
  'PNPM_HOME', 'DEVELOPER_DIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', '__CF_USER_TEXT_ENCODING',
];

export const DEFAULT_ENV_DENY = [
  '*_TOKEN', '*_TOKEN_*', '*_SECRET', '*_SECRET_*', '*SECRET_KEY*', '*_API_KEY', '*_APIKEY', '*_KEY',
  '*PASSWORD*', '*PASSWD*', '*_CREDENTIALS', '*_CREDENTIAL', 'AWS_*', 'GITHUB_TOKEN', 'GH_TOKEN',
  'NPM_TOKEN', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', '*_PAT', 'MCP_TERMINAL_*',
];

const SandboxSchema = z.object({
  /** Directories the session may write to. Placeholders: {cwd} {tmpdir} {darwin_cache} {home}, and ~. */
  allow_write: z.array(z.string()).default(DEFAULT_ALLOW_WRITE),
  /** Paths the session may not read (files or directories). */
  deny_read: z.array(z.string()).default(DEFAULT_DENY_READ),
  /** allow = unrestricted, localhost = loopback only, deny = no network (unix sockets still allowed). */
  network: z.enum(['allow', 'localhost', 'deny']).default('allow'),
  /** Raw Seatbelt (SBPL) lines appended at the end of the generated profile. Advanced. */
  extra_rules: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  security: z
    .object({
      /** workspace = Seatbelt sandbox (macOS sandbox-exec); host = no OS sandbox. */
      profile: z.enum(['workspace', 'host']).default('workspace'),
      /** A session cwd must be inside one of these roots. */
      allowed_roots: z.array(z.string()).default(['~', '/tmp']),
      /** cwd used when a tool call does not pass one. Defaults to the first allowed root. */
      default_cwd: z.string().optional(),
      default_decision: DecisionSchema.default('allow'),
      /** Built-in deny/ask rules for dangerous commands (sudo, rm -rf, curl | sh, git push --force, ...). */
      builtin_rules: z.boolean().default(true),
      rules: z.array(RuleSchema).default([]),
      env: z
        .object({
          inherit: z.enum(['all', 'allowlist']).default('allowlist'),
          allowlist: z.array(z.string()).default(DEFAULT_ENV_ALLOWLIST),
          deny_patterns: z.array(z.string()).default(DEFAULT_ENV_DENY),
          /** Also unset deny-pattern variables exported by the user's shell rc files inside sessions. */
          scrub_after_rc: z.boolean().default(true),
          set: z.record(z.string(), z.string()).default({}),
        })
        .prefault({}),
      sandbox: SandboxSchema.prefault({}),
      approval: z
        .object({
          /** auto: MCP elicitation if the client supports it, else a macOS dialog, else termctl. */
          mode: z.enum(['auto', 'elicit', 'dialog', 'cli', 'deny']).default('auto'),
          ttl_s: z.number().int().min(10).max(3600).default(300),
          dialog_timeout_s: z.number().int().min(5).max(600).default(60),
        })
        .prefault({}),
      redact: z
        .object({
          enabled: z.boolean().default(true),
          /** Literal secret values to mask in output (in addition to values of stripped env vars). */
          secrets: z.array(z.string()).default([]),
          patterns: z.array(z.object({ name: z.string(), regex: z.string() })).default([]),
        })
        .prefault({}),
    })
    .prefault({}),
  shell: z
    .object({
      program: z.string().optional(),
      login: z.boolean().default(true),
      /** Resolve PATH etc. from an interactive login shell once at startup (GUI-launched clients get a minimal env). */
      resolve_login_env: z.boolean().default(true),
      /** off = sessions do not write the user's shell history. */
      history: z.enum(['off', 'user']).default('off'),
      /** Load the user's rc files in interactive shells (user) or start a clean shell (clean). */
      rc: z.enum(['user', 'clean']).default('user'),
    })
    .prefault({}),
  limits: z
    .object({
      max_sessions: z.number().int().min(1).max(256).default(16),
      ring_buffer_bytes: z.number().int().min(64 * 1024).default(4 * 1024 * 1024),
      global_buffer_bytes: z.number().int().min(1024 * 1024).default(64 * 1024 * 1024),
      default_read_bytes: z.number().int().min(1024).default(16 * 1024),
      max_read_bytes: z.number().int().min(4096).default(64 * 1024),
      default_wait_ms: z.number().int().min(0).default(10_000),
      max_wait_ms: z.number().int().min(1000).default(30_000),
      default_run_timeout_s: z.number().int().min(0).default(600),
      idle_ttl_s: z.number().int().min(0).default(3600),
      retain_after_exit_s: z.number().int().min(0).default(1800),
      spill_max_bytes: z.number().int().min(0).default(100 * 1024 * 1024),
      spill_retention_days: z.number().min(0).default(7),
      default_cols: z.number().int().min(20).max(1000).default(120),
      default_rows: z.number().int().min(5).max(500).default(40),
    })
    .prefault({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().optional(),
      record_output: z.enum(['none', 'hash']).default('hash'),
    })
    .prefault({}),
  output: z
    .object({
      text_format: z.enum(['render', 'json', 'both']).default('render'),
    })
    .prefault({}),
  state_dir: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
