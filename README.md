# mcp-terminal：给 Agent 用的本地终端 MCP Server（macOS）

`mcp-terminal` 让任何 MCP 客户端（Manus、Claude Desktop、Cursor、自研 Agent……）通过 stdio 在本机创建并控制终端会话：启动命令、按游标增量读取输出、向交互式程序写入、判断“在跑 / 等输入 / 已结束”，并在需要时中断或终止整棵进程树。所有会话默认运行在 macOS Seatbelt 沙箱里，沙箱可写目录可以由你指定。

它不是把单次 `exec` 包成一个 Tool，而是一个有状态的终端服务：会话里的 `cd`、`export`、虚拟环境会保留；长任务不会阻塞调用方；输出不会因为没及时读取而丢失；客户端断开或服务崩溃后，残留进程会被找回并清理。

## 特性一览

| 方面 | 做法 |
| --- | --- |
| 会话模型 | PTY（node-pty）为默认后端，另有 pipe 后端用于分离 stdout/stderr；每个会话有 `session_id`，也可起名（`name="devserver"`）后用名字引用 |
| 命令边界与退出码 | 向 zsh / bash 注入 OSC 133 shell 集成标记（带每会话随机 nonce，程序伪造的标记会被忽略），`terminal_exec` 返回这条命令自己的输出与退出码，并跟踪 `cwd` |
| 增量输出 | 单调递增的字节游标；内存环形缓冲 + 磁盘分段溢写；省略游标即“从上次读到的地方继续”；超长输出头尾保留、中间给出可分页的游标 |
| 不阻塞的等待 | `until=["command_done"|"exit"|"input"|"idle:<ms>"|"pattern:<regex>"]` 在服务端等待，带超时、取消和进度通知；默认最多等 10 秒就返回“仍在运行” |
| 交互输入 | `terminal_send` 支持文本、`submit`、按键名（`C-c`、`Up`、`Escape`、`F5`……，自动适配应用光标模式）；检测“等待输入”（前台进程阻塞在 tty 读 + 提示符启发式） |
| 全屏程序 | 基于 `@xterm/headless` 维护屏幕模型；vim、top、less 等进入备用屏幕时自动返回渲染后的屏幕快照 |
| 输出整理 | 默认去掉 ANSI 颜色与控制序列，`\r` 进度条折叠为最终状态；`view="raw"` 可取原始内容 |
| 沙箱 | 每个会话用 `sandbox-exec` 套一份动态生成的 Seatbelt 配置：可读大部分文件，只能写会话 cwd 和你允许的目录；凭据目录不可读；网络可设 `allow / localhost / deny` |
| 命令策略 | tree-sitter-bash 解析整条命令（管道、`&&`、`$( )`、`sh -c "…"`、`env/xargs/timeout` 包装都会展开），内置危险命令规则 + 用户规则，整体取最严 |
| 审批 | 需审批的命令依次尝试：MCP elicitation（客户端支持时）→ macOS 原生对话框 → `termctl approve <id>` 审批票据；审批与参数摘要绑定、一次性、会过期 |
| 环境变量与脱敏 | 默认白名单继承环境变量，`*_TOKEN`、`*_KEY`、`AWS_*` 等被剥离（rc 文件里再导出的也会在会话内 unset），其值和常见令牌格式在输出中被替换为 `[REDACTED:…]` |
| 审计 | JSONL 审计日志，按实例做哈希链，`termctl audit verify` 可检测篡改；只记录输出哈希，不记录输出内容 |
| 生命周期 | 关闭会话时按 SIGHUP → SIGTERM → SIGKILL 升级，覆盖进程组、tty 上的作业和已脱离的 `nohup` 进程；SQLite 注册表记录会话与观察到的进程组，服务崩溃重启后自动对账并清理孤儿进程 |

## 环境要求

macOS（已在 macOS 26.5 / Apple Silicon 上测试；所用 Seatbelt 规则在较早版本上同样可用，但未逐一验证），Node.js 22.13 及以上（需要内置的 `node:sqlite`）。不需要 Xcode：node-pty 自带 macOS 预编译二进制，bash 解析器使用 WASM。

## 安装与自检

```bash
git clone https://github.com/dogeheng/MCP-server-controller.git
cd MCP-server-controller
npm install          # postinstall 会修复 node-pty spawn-helper 的执行权限
npm run build
node dist/bin/termctl.js doctor
```

`doctor` 会检查 Node 版本、`sandbox-exec`、PTY 能否启动、解析器能否加载、当前生效的沙箱与审批配置。可以 `npm link` 把 `mcp-terminal` 和 `termctl` 两个命令放进 PATH，下文为简洁起见直接写命令名。

## 接入 MCP 客户端（stdio）

最简单的方式是让 `termctl` 生成配置片段，它会写入当前 Node 的绝对路径（GUI 应用启动时 PATH 往往不完整）：

```bash
termctl client-config --workspace ~/Projects/demo
```

输出形如：

```json
{
  "mcpServers": {
    "terminal": {
      "command": "/Users/you/.n/bin/node",
      "args": ["/path/to/mcp-terminal/dist/bin/mcp-terminal.js", "--workspace", "/Users/you/Projects/demo"]
    }
  }
}
```

**Manus**：在 Manus 的自定义 MCP（Custom MCP）里选择以 JSON / 命令方式添加，粘贴上面的 `mcpServers` 片段即可（stdio 形式为 `command` + `args` + 可选 `env`）。添加后先让 Agent 调一次 `terminal_list` 或 `terminal_run {"command":"pwd"}` 验证。已在 Manus Studio 桌面端实测：服务由本机的 `manus-computer-operator` 以 stdio 方式拉起，运行在这台 Mac 上；服务进程退出后，下一次工具调用会自动重新拉起。Manus 目前不声明 elicitation 能力，所以需要审批的命令会弹出 macOS 原生对话框，超时后退回到 `termctl approve <id>`。修改代码并 `npm run build` 后，在活动监视器里结束名为 `node` 且命令行含 `dist/bin/mcp-terminal.js` 的进程，Manus 下次调用时就会加载新版本。完整测试步骤见 [TESTING.md](TESTING.md)。

**Claude Desktop**：把片段合并进 `~/Library/Application Support/Claude/claude_desktop_config.json`。**其他客户端**：只要支持 stdio 传输，配置方式相同。

服务端同时支持 2025-era 的 `initialize` 握手和 2026-07-28 版协议（无初始化握手、MRTR 形式的 elicitation），由 SDK 在首个请求时自动选择。

## 设定沙箱目录

沙箱是“读宽写窄”：会话能读系统里的大部分文件（凭据目录除外），但只能写下面这些位置。

| 方式 | 作用 |
| --- | --- |
| `--workspace <dir>` | 最常用。会话只能在 `<dir>` 内启动（allowed_roots = [dir]），默认 cwd = dir，沙箱可写 = 会话 cwd + 临时目录 |
| `--root <dir>`（可重复） | 只设置允许的工作目录根，替换默认的 `~`、`/tmp` |
| `--cwd <dir>` | 默认工作目录 |
| `--allow-write <dir>`（可重复） | 额外可写目录，例如 `~/.npm`、`~/Library/Caches`、`~/.cargo` |
| `--deny-read <path>`（可重复） | 额外不可读路径 |
| `--network allow|localhost|deny` | 网络策略；`deny` 时仍允许 Unix socket |
| `--profile host` / `--no-sandbox` | 不使用 OS 沙箱（命令策略与审批仍生效） |

同样的设置都可以写进 `~/.config/mcp-terminal/config.toml`，带注释的完整示例见 [config.example.toml](config.example.toml)。`termctl sandbox-profile --cwd <dir>` 可以打印实际生成的 Seatbelt 配置。服务自身的状态目录（`~/.local/state/mcp-terminal`）和配置目录在沙箱内不可写、关键部分不可读，Agent 无法篡改审批记录、审计日志或给自己加规则。

在沙箱里，写 home 目录下的文件会得到 `Operation not permitted`，这是预期行为。zsh 的补全缓存和 oh-my-zsh 缓存已被重定向到可写的用户缓存目录；vim 的 `.viminfo` 等写不了的文件会提示错误但不影响编辑。

## 工具一览

所有工具都同时返回一段便于模型阅读的文本（首行是 `[session · 状态 · 退出码]` 摘要，末行是下一步建议）和对应的 `structuredContent`。出错时返回 `isError: true`，`structuredContent.error` 含 `code`、`message` 和 `hint`。

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `terminal_run` | 一次性命令，等待结束并返回 stdout / stderr / 退出码；超过 `wait_ms` 仍未结束则返回 `session_id` 以便后续读取 | `command`, `cwd`, `stdin`, `timeout_s`, `wait_ms`, `max_bytes` |
| `terminal_create` | 创建持久会话：交互 shell（默认），或直接运行程序（`program` + `args`，如 python3、node、npm run dev） | `program`, `args`, `shell`, `mode`(pty/pipe), `name`, `cwd`, `env`, `cols`, `rows`, `idle_ttl_s` |
| `terminal_exec` | 在 shell 会话中执行一条命令，返回这条命令的输出、退出码和新的 cwd；超时返回 `running` | `session_id`, `command`, `wait_ms`, `max_bytes`, `view` |
| `terminal_send` | 向会话写入文本和按键，返回随后产生的输出 | `session_id`, `text`, `keys`, `submit`, `wait_ms`, `view` |
| `terminal_read` | 按游标增量读取输出，可在服务端等待条件 | `session_id`, `cursor`, `until`, `wait_ms`, `max_bytes`, `view`(text/raw/screen), `stream`, `tail_lines` |
| `terminal_status` | 会话状态与活动判断（idle / busy / awaiting_input / exited）、前台进程、未读字节数 | `session_id` |
| `terminal_list` | 列出会话 | `state`(running/all) |
| `terminal_signal` | 向前台作业或整个会话发信号 | `session_id`, `signal`, `target` |
| `terminal_resize` | 调整 PTY 尺寸 | `session_id`, `cols`, `rows` |
| `terminal_close` | 结束会话及其整棵进程树，可保留输出供之后读取 | `session_id`, `grace_ms`, `keep_output` |

所有会执行命令或写入输入的工具都接受 `approval_id`，用于审批后的重试。

## 典型调用编排

一次性命令：

```text
terminal_run {"command": "git status --short && npm test"}
→ [term_x · exited · exit 0 · 8.2s] …输出…
```

多步工作（状态会保留）：

```text
terminal_create {"name": "main"}
terminal_exec {"session_id": "main", "command": "cd api && source .venv/bin/activate"}
terminal_exec {"session_id": "main", "command": "pytest -q"}
```

长任务：先短等，再跟随输出直到结束，期间不会丢输出：

```text
terminal_exec {"session_id": "main", "command": "npm run build", "wait_ms": 3000}
→ status: running
terminal_read {"session_id": "main", "until": ["command_done"], "wait_ms": 30000}
```

开发服务器：放在独立会话里，等到就绪行出现：

```text
terminal_create {"name": "dev", "program": "npm", "args": ["run", "dev"]}
terminal_read {"session_id": "dev", "until": ["pattern:Local:|listening on|ready in"], "wait_ms": 30000}
```

交互程序：

```text
terminal_exec {"session_id": "main", "command": "npm init"}
→ status: awaiting_input, "package name: (demo)"
terminal_send {"session_id": "main", "text": "my-pkg", "submit": true}
terminal_send {"session_id": "main", "keys": ["C-c"]}      # 中断
```

全屏程序：

```text
terminal_exec {"session_id": "main", "command": "vim notes.txt"}      # 自动返回屏幕快照
terminal_send {"session_id": "main", "text": "ihello", "keys": ["Escape"]}
terminal_send {"session_id": "main", "text": ":wq", "submit": true}
```

## 安全模型

**三道防线**，彼此独立：OS 沙箱限制“能碰到什么”，命令策略限制“能直接说什么”，审批把高风险操作交给人决定。沙箱是硬边界；策略解析是尽力而为（无法覆盖脚本内部的行为），所以默认两者同时开启。

**内置规则**（`termctl check "<命令>"` 可查看任意命令的判定与原因）：`sudo/su/doas`、格式化磁盘、`dd of=/dev/…`、关机、`csrutil/nvram`、`rm -rf` 关键路径（`/`、`~`、`/System`……）以及 fork bomb 为 **deny**；`rm -rf <目录>`、`find -delete`、`git push --force`、`git reset --hard`、`git clean -f`、`curl … | sh`、`chmod -R`、`killall`、`npm publish`、`docker system prune`、`kubectl delete`、`launchctl load`、读取钥匙串密码、`osascript` 以及无法静态判定的动态命令为 **ask**。用户规则可以把 ask 放宽为 allow，也可以新增 ask / deny；内置 deny 是底线，规则无法放宽。项目目录里的 `.mcp-terminal.toml` 只能让策略更严格。

**审批流程**（`security.approval.mode`，默认 `auto`）：

1. 客户端声明支持 elicitation 时，直接在客户端界面里弹出审批表单（允许一次 / 总是允许 / 拒绝）。
2. 否则弹出 macOS 原生对话框，默认按钮是“拒绝”，超时（默认 60 秒）不算同意。
3. 都不可用或超时时，返回 `APPROVAL_REQUIRED` 和一个审批 ID，Agent 会请你在自己的终端里运行 `termctl approve apr_xxx`，然后带 `approval_id` 重试。审批只对完全相同的参数有效、只能用一次、默认 5 分钟过期。

“总是允许”会把这条精确命令（限定在该目录）写入 `~/.config/mcp-terminal/rules.toml`，可随时编辑或删除。

**审计**：每次工具调用、策略判定、审批、会话开始与结束都写入 `~/.local/state/mcp-terminal/audit/*.jsonl`。`termctl audit tail` 查看最近记录，`termctl audit verify` 校验哈希链。

## 生命周期与恢复

会话在空闲超过 `idle_ttl_s`（默认 1 小时）后自动关闭；结束的会话输出保留 `retain_after_exit_s`（默认 30 分钟）供读取。全局内存超出预算时，最久没有活动的会话先缩减内存缓冲，被淘汰的输出仍可从磁盘溢写日志中读取。客户端关闭 stdin、发送 SIGTERM/SIGINT/SIGHUP，或父进程消失（被 launchd 接管）时，服务会终止全部会话后退出。

如果服务被强制杀死，PTY 会话中的普通进程会随 PTY 关闭收到 SIGHUP 自行退出；pipe 会话和 `nohup` 后台进程会被下一次启动的服务根据注册表中记录的进程组（校验进程启动时间，避免误杀 PID 复用的进程）找回并清理，会话状态标记为 `lost`。也可以随时手动运行 `termctl cleanup`。

## termctl

```text
termctl approvals                 列出待审批请求
termctl approve <id> [--always]   批准（--always：记住这条命令）
termctl deny <id>                 拒绝
termctl sessions [--all]          注册表中的会话
termctl cleanup                   清理已失去服务端的会话进程
termctl check "<cmd>" [--cwd d]   查看一条命令的策略判定
termctl sandbox-profile [--cwd d] 打印生成的 Seatbelt 配置
termctl audit verify | tail [-n N]
termctl config                    生效配置及其来源
termctl doctor                    环境自检
termctl client-config [--workspace d]  生成 MCP 客户端配置片段
```

## 测试

```bash
npm test                 # 构建后运行单元测试与集成测试
npx vitest run test/unit # 只跑单元测试
```

集成测试会通过 stdio 启动真实服务，覆盖：退出码与 stderr 分离、shell 状态保持、等待输入检测与应答、长任务游标续读、正则就绪等待、`C-c` 中断、沙箱写入限制、工作目录根限制、策略拒绝与审批票据、密钥脱敏、关闭时清理整棵进程树（含 `nohup`）、以及 2026-07-28 协议下的 elicitation 审批。

## 已知限制

仅支持 macOS。`sandbox-exec` 已被苹果标记为弃用但在当前系统上仍可用（Codex CLI、Claude Code 的 macOS 沙箱同样基于它）；若未来不可用，`termctl doctor` 会报告，可暂时用 `--profile host` 运行。沙箱内的网络只有开关和仅本机两档，没有按域名过滤。命令策略是静态分析，无法判断脚本文件内部会做什么，这部分由沙箱兜底。等待输入检测对没有提示符、也不阻塞在 tty 读的程序可能判断为 `busy`，此时可用 `until=["idle:2000"]`。登录 shell 环境在启动时解析一次（oh-my-zsh 等较慢的配置约 2 秒），第一次创建会话会等待它完成。

## 目录结构

```text
src/
  bin/            mcp-terminal（stdio 服务入口）、termctl（管理 CLI）
  server.ts       运行时装配与 MCP Server 构建
  mcp/            工具注册与渲染、审批守卫（elicitation / 对话框 / 票据）
  core/           会话、管理器、等待器、输出视图、按键映射、环境变量
  backends/       PTY 与 pipe 进程后端
  detect/         shell 集成脚本生成、OSC 133/7 标记扫描
  output/         环形缓冲、磁盘溢写、文本规范化、屏幕模型、脱敏
  policy/         命令解析、策略引擎、审批存储、macOS 对话框
  sandbox/        Seatbelt 配置生成
  store/          SQLite 会话注册表、哈希链审计日志
  config/         配置结构与分层加载
test/             单元测试与集成测试
examples/         测试用的交互脚本（greet.py）
docs/             技术选型报告与初步设计
```

设计背景与各关键节点的选型对比见 [docs/tech-selection-report.md](docs/tech-selection-report.md)，Manus 中的分步测试见 [TESTING.md](TESTING.md)。

## 许可证

[MIT](LICENSE) © dogeheng
