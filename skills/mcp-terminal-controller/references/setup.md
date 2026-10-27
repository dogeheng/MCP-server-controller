# Local server setup

Use this reference only when the MCP terminal tools are missing or the server reports a setup problem.

## Requirements

- A Mac and an MCP client that can launch a **local stdio server**.
- For the source/npm installation: Node.js 22.13 or newer, with the dependencies declared by the server.
- The official portable release includes its own runtime and is **macOS Apple silicon only**. Do not use that binary package on Windows, Linux, or Intel Macs.
- `sandbox-exec` must be available for the default workspace sandbox. Diagnose an unavailable sandbox instead of silently disabling it.

Agensi's remote MCP connection delivers these instructions. It does not host this local terminal server. A cloud-only client without access to a local stdio server cannot use this skill's terminal workflows.

## Install from the author's release

Project: https://github.com/dogeheng/MCP-server-controller

Releases: https://github.com/dogeheng/MCP-server-controller/releases

For Apple silicon, download the `mcp-terminal-v0.1.0-macos-arm64.zip` asset from the v0.1.0 release, check it against that release's `SHA256SUMS.txt`, and extract it to a stable location chosen by the user. Use the actual release filenames if a newer version is deliberately selected. The package contains native code and the runtime; review its source and installation instructions before running it.

In the extracted directory:

```sh
./bin/termctl doctor
./bin/termctl client-config --workspace /absolute/path/to/project
```

`doctor` prints individual checks; inspect them rather than relying only on its process exit code. The client-config command prints a JSON snippet and does not install it into an editor. It embeds absolute paths, so regenerate it after moving the package.

For an existing npm installation, the equivalent commands are `termctl doctor` and `termctl client-config --workspace /absolute/path/to/project`.

## Source installation alternative

In a user-selected tools directory, after authorization to install this dependency:

```sh
git clone https://github.com/dogeheng/MCP-server-controller.git
cd MCP-server-controller
npm ci
npm run build
node dist/bin/termctl.js doctor
node dist/bin/termctl.js client-config --workspace /absolute/path/to/project
```

Replace the example project path with the real directory. Do not overwrite an existing checkout. `npm ci` downloads dependencies and runs package lifecycle scripts. No administrator privileges or global installation are required. Do not assume the `mcp-terminal` name on a package registry is an official published package; use the author's repository or GitHub release assets.

## Connect the client

Merge the generated `mcpServers.terminal` entry into the client's existing local MCP configuration using its supported mechanism. Preserve other entries. Clients with another configuration format need the same generated executable and argument list, adapted to their documented format. Installing this skill does not authorize unrelated configuration changes.

The generated entry uses an absolute Node executable and the absolute server entrypoint, with `--workspace` restricted to the selected project. Avoid a broad home-directory workspace. Reload the client's MCP connection when needed, then verify that its discovered tools include `terminal_list`, `terminal_run`, `terminal_create`, `terminal_exec`, `terminal_read`, `terminal_send`, `terminal_status`, and `terminal_close`.

Call `terminal_list` and a harmless `terminal_run` with `command: "pwd"` and the project's `cwd`. Check that the reported directory is correct before doing project work.

## Diagnose a failed setup

- Missing tools: verify the absolute executable/entrypoint paths, the client's local stdio support, and its MCP startup log.
- PTY spawn failure: inspect the PTY check in `doctor`; the server includes a repair for its own spawn-helper permissions. Do not recursively change system permissions.
- Write denied: check the requested directory against `--workspace`. Any extra writable cache directory needs a specific reason and user authorization.
- CLI approval tickets: use the `termctl` belonging to the same installation and state directory as the active server. An agent may display instructions, but the human decides approval.
- Keep approval stores, audit logs, environment values, and client credentials local. Diagnostic reports should contain only the information needed to explain the failure.
