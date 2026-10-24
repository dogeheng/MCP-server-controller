# 在 Manus 中测试 mcp-terminal

本文档给出一组可以直接发给 Manus 的测试提示词，以及每一步应该看到的结果。所有测试都在沙箱工作区 `playground/` 中进行，不会改动这个目录以外的文件。

## 准备

按 README 的“接入 MCP 客户端”一节注册连接器（下文假设名称为 **MCP Terminal**），并用 `--workspace` 指定一个沙箱工作区，例如：

```bash
mkdir -p ~/mcp-playground && cp examples/greet.py ~/mcp-playground/
node dist/bin/termctl.js client-config --workspace ~/mcp-playground
```

下文把这个目录称为 `playground`。

新开一个 Manus 任务，确认任务的连接器列表里 **MCP Terminal** 处于开启状态。为了在自己的终端里观察服务端状态，可以先设置一个别名：

```bash
alias termctl="node $PWD/dist/bin/termctl.js"   # 在仓库根目录执行
termctl doctor
```

在提示词里写明“用 MCP Terminal”，可以让 Manus 使用这个连接器，而不是它自带的命令执行工具。

## 测试清单

| # | 测什么 | 发给 Manus 的提示词 | 预期结果 |
| --- | --- | --- | --- |
| 1 | 连通性 | 用 MCP Terminal 运行 `pwd` 和 `sw_vers`，告诉我结果 | 路径是上面的 `playground`，退出码 0，显示 macOS 版本 |
| 2 | 会话状态保持 | 用 MCP Terminal 建一个叫 work 的会话，依次执行 `mkdir -p demo && cd demo`、`export X=42`，再执行 `pwd; echo $X` | 第三步的 cwd 是 `playground/demo`，输出 42；每一步都单独报告退出码 |
| 3 | 交互输入 | 在 work 会话里运行 `python3 ../greet.py`，按提示回答名字和语言 | 第一次返回状态为“等待输入”并显示“你的名字是？”，回答后出现第二个问题，最后打印问候语，退出码 0 |
| 4 | 长任务与增量输出 | 在 work 会话里运行 `for i in $(seq 1 20); do echo step $i; sleep 1; done`，先等 3 秒告诉我进度，然后等它跑完 | 第一次返回 running 和前几行；随后的读取续上而不重复，最终 20 行齐全，退出码 0 |
| 5 | 后台服务与就绪等待 | 用 MCP Terminal 在一个叫 web 的会话里启动 `python3 -m http.server 8765`，等到出现 “Serving HTTP” 后，用另一个命令 curl `http://127.0.0.1:8765/greet.py`，再看一下服务日志，最后关掉服务 | 就绪等待立即命中；curl 返回 HTTP 200；服务日志里有 GET 记录；关闭后状态为 killed |
| 6 | 全屏程序 | 在 work 会话里用 vim 新建 notes.txt，写入 hello，保存退出，然后 cat 出来 | 进入 vim 时返回屏幕画面；保存退出后 cat 显示 hello |
| 7 | 中断 | 在 work 会话里运行 `sleep 100`，然后用 Ctrl-C 中断它 | 命令以退出码 130 结束，会话回到提示符 |
| 8 | 沙箱 | 用 MCP Terminal 尝试 `touch ~/outside.txt` 和 `cat ~/.ssh/config` | 两者都报 `Operation not permitted`；home 下不会出现 outside.txt |
| 9 | 工作目录限制 | 用 MCP Terminal 在 `/usr` 目录下运行 `ls` | 返回 `CWD_NOT_ALLOWED`，并提示允许的目录 |
| 10 | 策略拒绝 | 用 MCP Terminal 运行 `sudo whoami` | 返回 `POLICY_DENIED`，命令不会执行 |
| 11 | 审批（允许） | 用 MCP Terminal 在 playground 里运行 `mkdir -p junk/a && rm -rf junk` | 屏幕上弹出“MCP Terminal · 命令审批”对话框；点“允许一次”后命令执行，退出码 0 |
| 12 | 审批（拒绝） | 再运行一次同样的命令，这次在对话框里点“拒绝” | 返回 `APPROVAL_DENIED`，junk 目录不受影响 |
| 13 | 审批（票据回退） | 再运行一次，这次不理会对话框，等它 60 秒后超时 | 返回 `APPROVAL_REQUIRED` 和一个 `apr_…` ID；在自己的终端执行 `termctl approve apr_…` 后告诉 Manus 重试，命令执行 |
| 14 | 密钥脱敏 | 用 MCP Terminal 运行 `echo ghp"_"abcdefghijklmnopqrstuvwxyz0123456789AB`（引号只是为了让文档里不出现完整的令牌字面量，shell 会把它拼成一个令牌） | 输出里看到的是 `[REDACTED:…]`，不是原始令牌 |
| 15 | 进程树清理 | 在 work 会话里运行 `nohup sleep 300 >/dev/null 2>&1 &`，然后关闭 work 会话 | 在自己的终端执行 `pgrep -fl "sleep 300"`，没有输出 |

关于第 11–13 项：Manus 目前不支持 MCP 的审批表单（elicitation），所以审批走 macOS 原生对话框。对话框弹出期间，这次工具调用会一直挂着，最长 60 秒。如果 Manus 在此之前就判定调用超时，说明它对单次调用的时限更短，可以在 `~/.config/mcp-terminal/config.toml` 的 `[security.approval]` 里把 `dialog_timeout_s` 调小（例如 25），或者设 `mode = "cli"`，直接走 `termctl approve` 票据流程。

## 进阶：崩溃恢复

这一项验证服务被强制杀死后，残留进程能否被找回。

1. 让 Manus 用 MCP Terminal 以 pipe 模式启动一个长任务：`terminal_create`，`program` 为 `sh`，`args` 为 `["-c", "sleep 600"]`，`mode` 为 `pipe`。
2. 打开“活动监视器”，找到命令行包含 `dist/bin/mcp-terminal.js` 的 `node` 进程，强制退出。
3. 再让 Manus 调用一次 `terminal_list`。Manus 会重新拉起服务，新实例启动时会对账并清理上一实例留下的进程。
4. 在自己的终端执行 `pgrep -fl "sleep 600"` 应该没有输出；`termctl sessions --all` 里那条会话的状态是 `lost`。

## 观察与排查

`termctl sessions --all` 列出注册表里的所有会话及其状态。`termctl audit tail -n 30` 查看最近的工具调用、策略判定和审批记录；`termctl audit verify` 校验审计哈希链是否完整。`termctl check "<命令>"` 可以在不执行的情况下查看某条命令会被允许、需要审批还是被拒绝，以及原因。`termctl sandbox-profile --cwd <目录>` 打印实际使用的 Seatbelt 配置。

如果 Manus 报告连接器调用失败，先在自己的终端运行 `termctl doctor`；服务日志写在 stderr，由 Manus 收集。修改代码并重新构建后，在活动监视器里结束上述 `node` 进程即可让 Manus 加载新版本。

## 本地自动化测试

```bash
cd MCP-server-controller
npm test
```

会先构建，再运行 30 个单元测试和 15 个集成测试，集成测试通过 stdio 启动真实服务，覆盖上面大部分场景。
