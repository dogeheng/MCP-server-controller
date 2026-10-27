---
name: mcp-terminal-controller
description: Use when the user wants to run commands, keep a persistent shell, follow a long build, answer an interactive prompt, or manage a development server through the mcp-terminal MCP server on macOS. Requires the separately installed local MCP-server-controller server and its terminal_* tools.
license: MIT
metadata:
  author: dogeheng
  version: "1.0.0"
---

# MCP Terminal Controller

Operate the local [MCP-server-controller](https://github.com/dogeheng/MCP-server-controller) server through its `terminal_*` tools. This skill provides workflow instructions; it does not install a server or grant terminal access by itself. The server runs on the user's Mac, even when skill discovery comes from a remote marketplace.

## Connect and choose a session

1. Check whether the client exposes this server's tools. Client prefixes may differ; identify the tools by their schemas and descriptions. If they are missing, use [references/setup.md](references/setup.md) for setup. Do not substitute an unrelated server or claim a command ran.
2. Confirm the requested project directory. Prefer a server configured with `--workspace` for that project. Call `terminal_list` before creating a session to avoid duplicates; inspect a candidate with `terminal_status` before reusing it.
3. Choose the execution mode:

| Task | Tool sequence |
| --- | --- |
| Short, self-contained command | `terminal_run`; provide `cwd` explicitly |
| Dependent commands, retained `cd` or environment | `terminal_create` without `program`, then `terminal_exec` |
| REPL, interactive program, or development server | `terminal_create` with `program` and `args`, then `terminal_send` / `terminal_read` |
| Separate stdout and stderr | `terminal_run`, or a program session with `mode: "pipe"` |

Use the returned `session_id` throughout. A shell accepts one command at a time. A session started with `program` is driven by `terminal_send`, not `terminal_exec`. Use separate sessions for concurrent work, and do not take over or close an unrelated session.

## Execute and follow the result

- Read `isError` and `structuredContent` when available; the text response contains the same evidence if structured output is unavailable. `status`, `state`, and `activity` are distinct fields: a shell can remain `state: "running"` after its command has completed.
- A call returning `status: "running"` means the task continues. Keep its session and read it; do not run the command again. `wait_ms` controls how long one call waits, while `terminal_run.timeout_s` can terminate the command.
- For a shell command, use `terminal_read` with `until: ["command_done", "input"]`. For a one-shot command or program that should terminate, wait for `exit`. For a server, wait for its actual readiness message with `pattern:<regex>`, then check the requested endpoint when appropriate. A readiness line alone does not prove application health.
- Use bounded waits, typically 1–10 seconds initially and up to 30 seconds when following work, within the advertised tool limits. On timeout inspect the returned evidence or `terminal_status`; quiet output or `idle` alone does not establish success.
- Omit `cursor` for sequential incremental reads, or use the returned `next_cursor` for explicit paging. If `has_more` is true, continue paging. If an exec result includes `omitted`, read from `omitted.from` to recover the omitted section. A read with `cursor: 0` intentionally replays retained output. Surface `dropped_bytes` if older output is no longer retained.
- Verify the command's exit code. A completed shell command reports `exit_code` in its exec response, `last_command.exit_code` in later reads, or a matching entry in `terminal_status.recent_commands`. Do not confuse the shell's process exit with its last command. Missing exit evidence remains unconfirmed.

Concrete request/response flows are in [references/workflows.md](references/workflows.md). Read only the examples relevant to the task.

## Interactive input and stopping

When the current output and activity indicate a prompt, answer with `terminal_send` using `text` and `submit: true`. Use only answers supported by the user's request; ask for missing consequential choices instead of selecting a destructive default. If input detection is uncertain, inspect recent output and status before sending anything.

For full-screen programs, read `view: "screen"` and use named keys with `terminal_send`. PTY output merges stdout and stderr; stream filtering requires pipe mode.

To interrupt the foreground job, send `keys: ["C-c"]` or `terminal_signal` with `signal: "SIGINT"` and `target: "foreground"`. Check the result before issuing another shell command. To terminate a session and its process tree, use `terminal_close`; it already escalates termination. Close the sessions you created when their work is finished, unless the user wants a server left running. Report any retained session and why it remains open. Do not use global orphan cleanup for an ordinary session close.

## Approvals and recovery

- `APPROVAL_REQUIRED`: show the command, directory, reason, and approval ID. Let the user approve through the client's form, native dialog, or their own terminal with the indicated `termctl approve` command. The agent must not approve its own request. After approval, retry the original tool call with every original argument unchanged and only `approval_id` added. Tickets are single-use, expire, and bind to that exact request.
- `APPROVAL_DENIED` or `POLICY_DENIED`: stop that operation. Do not rephrase, split, encode, or route it through another tool to evade the decision.
- `APPROVAL_INVALID`: inspect the error; a changed request or expired ticket needs a fresh approval rather than a fabricated ID.
- `SESSION_BUSY`: read or answer the current job before submitting another command.
- `SESSION_EXITED` / `SESSION_NOT_FOUND`: inspect retained output and `terminal_list`. Recreate a session only if still needed; do not automatically replay a command whose effects are uncertain.
- `CWD_NOT_ALLOWED` / `SANDBOX_UNAVAILABLE`: explain the boundary and resolve setup with the user. Keep the workspace profile and approval controls enabled; do not automatically widen writable roots or switch to an unsandboxed profile.

The sandbox generally allows reading many local files while limiting writes. Its command analysis and redaction are best-effort controls, not permission to inspect private files or expose credentials. Use the task's authorized paths and inputs. Installation may download the public GitHub release or npm dependencies; normal terminal work follows the user's configured network policy. This skill has no telemetry or account requirement of its own.

## Report

State what ran, its directory, the observed result and exit evidence, and any unresolved prompt or approval. Include the session ID only when the user needs to resume or stop a retained task. Distinguish successful completion, still-running work, and blocked work from the actual tool results.
