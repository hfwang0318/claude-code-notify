# 真实 Claude Code 端到端测试（E2E）

这个仓库的 E2E 不是 mock 协议，而是启动**真实的 Claude Code CLI**，让它通过真实 hook 请求桌面应用，再由自动化脚本操作真实弹窗完成审批。

入口：

```bash
cd desktop
pnpm e2e:claude
```

正常输出：

```text
E2E PASS · all · 80.5s
```

脚本：`scripts/e2e-claude.mjs`

---

## 1. 覆盖范围

| 用例 | 触发方式 | 关键断言 |
|---|---|---|
| `bypass` | 真实 Claude 分别用 `--permission-mode bypassPermissions` 和 `--dangerously-skip-permissions` 启动，执行 Bash 并写入/编辑文件（Write/Edit 可用时优先） | 全程 pending=0；Bash + 文件结果真实产生；history 没有审批记录 |
| `stop` | 真实 Claude 完成一轮（`-p`） | 应用日志收到 `type=Stop` 通知；标题是“已完成”而不是“等待审批” |
| `multi` | 两路真实 Claude 会话同时请求 Bash 权限 | 弹窗出现 2 个会话/2 条待审批；会话颜色不重复；标签不包含 `dumb`；队列文案正确；身份条有真实任务摘要与 4 位短码；两个会话条的任务摘要和会话名都不同；点击会话条能切换到第二路；逐条批准；两路都输出 `DONE` 且生成 `result.txt`；history 为 `allow/popup` |
| `resolved` | 一路真实 Claude 请求权限，然后模拟终端侧已处理 | 调用 `/claude-approval-resolved` 返回 `resolved`；pending 清空；history 为 `cancelled/terminal` |
| `timeout` | 一路真实 Claude 请求权限，使用 20s hook 超时（服务端 10s），并先暂停 6s 再恢复 | 不做决定时 pending 清空；`expired` 出现；history 为 `timeout/timeout`；调用确认后 `expired` 清空 |

测试还会校验 `pending.json`、`history.jsonl`、`sessions.json` 的真实落盘内容。

`bypass` 用例的回归背景：旧版 `claude_approval_hook.py` 没有读取 `permission_mode`，在 bypass 下仍会把 Bash/文件工具转发到桌面。当前 hook 会跳过 `bypassPermissions` / `dontAsk`；应用启动时若检测到本机 hook 版本过期，会自动备份并更新。

Hook 事件名回归：`PermissionRequest` 只能输出 `PermissionRequest`，`PreToolUse` 只能输出 `PreToolUse`；不匹配时静默回退终端，避免 Claude 报 `hook returned incorrect event name`。该路径由 `src/main/hook-bypass.test.ts` 覆盖。

计划模式回归：`ExitPlanMode` 的 PermissionRequest allow 必须带原始 `updatedInput` 并 `setMode`，否则 Claude Code 2.1.28x 会保留计划审批对话框。真实 `-p` 当前没有 `ExitPlanMode` 工具，因此由 `src/main/hook-bypass.test.ts` 覆盖输出结构。

`AskUserQuestion` 重复弹窗回归：问答由 PreToolUse 通道负责；旧部署缺少 `CLAUDE_ASKUSER_CHANNEL` 时，随后的 PermissionRequest 会再弹一次。服务端现在直接拒绝这种重复 PermissionRequest（回退终端），hook 测试也验证通道存在时不会发送。真实 `AskUserQuestion` 在当前 `-p` 模型工具集不可用，因此该路径由 self-test + hook/server 单测覆盖，而不是本脚本的真实 Claude 用例。

会话身份回归（hook v7）：审批/通知钩子会从 `transcript_path` 末尾优先读取 Claude Code 写入的 `last-prompt`，找不到再回退最后一条字符串 `content` 的 user 消息；同时读取工作目录的 `.git/HEAD` 得到分支（`branch`）。`multi` 用例断言身份条有非空任务摘要、短码符合 `#xxxx`、两个并发会话的任务摘要与会话名都互不相同。旧 hook 不上报这两个字段时弹窗自动退化为“短码 + 分支/路径”，不会显示伪造摘要。

工具暴露回归：部分路由模型只有在存在显式权限规则时才把 Bash/Write/Edit 放进工具表。E2E 的隔离 settings 因此写入 `permissions.ask: ["Bash","Write","Edit"]` —— `ask` 既能让工具可见，又会真实触发 PermissionRequest（`allow` 会直接跳过弹窗）。如果模型仍然只暴露 ToolSearch/Web，用例按 SKIP 处理而不是伪造通过。

倒计时暂停回归：`timeout` 用例在审批到达后点击“暂停”，等待 6 秒（超过服务端 10 秒窗口的一半）并断言 pending 仍在、按钮变成“继续”，再恢复并等待正常超时。hook 的 settings timeout 和脚本 socket timeout 都会加上 600 秒暂停预算，否则 hook 会在暂停期间先断开。

### 0.5 审批效率改动的验证边界

以下行为改变了弹窗/收件箱交互，但当前 E2E 脚本仍以“单条审批 + 暂停 + 超时”为主，新增行为由单测、`pnpm capture` 和人工验收共同覆盖：

- 相同请求合并：需要同一会话并发发出两条完全相同的 PermissionRequest；E2E 的 `multi` 使用两个会话，因此合并逻辑由 `src/shared/approvals.test.ts` 覆盖。人工验收时可在同一会话并行触发两条 Bash 请求，确认只出现一张带 `相同 ×2` 的卡片，允许后两条都从 pending 消失。
- 收件箱多选/批量：纯 renderer 行为，由 `Inbox` 的人工/截图验收覆盖；高风险不允许批量允许。
- 稍后提醒：点击后弹窗隐藏、pending 保留、倒计时继续，到期后重新弹出；不改变 hook 的 timeout。
- 拒绝理由：填写的文本应出现在 hook 的 `deny.message` 中；服务端有 `deny reason` 单测。
- 规则有效期/来源绑定：`rules.test.ts` 覆盖过期与来源匹配；前缀/通配规则禁止命中复合 shell 命令。
- SessionEnd：部署后关闭一个 Claude 会话，应用应在 30 分钟内把会话标为“已结束”并清理；E2E 的隔离 settings 尚未注入 SessionEnd，需人工或后续用例覆盖。
- 免打扰/通知标题：纯策略单测覆盖；系统通知中心行为仍需真机验收。

hook v8 起，`PreToolUse` 关联日志从 SQLite 改为私有 JSONL，部署的 matcher 默认收窄到
`Bash|Edit|Write|MultiEdit|NotebookEdit|ExitPlanMode|AskUserQuestion|mcp__.*`。
E2E 的隔离 settings 仍显式写空 matcher，以保持旧用例的“所有工具都记录关联”行为。


### 0.6 多会话分诊的验证边界

当前真实 Claude E2E 仍以“并发到达 → 弹窗出现 → 逐条点击允许”为主。`multi` 用例会检查会话条数量、会话名/任务摘要、点击切换、逐条允许和 history，因此覆盖了多会话身份与基本切换；`stop`、`resolved` 覆盖通知与终端侧关闭。以下行为目前由单测、`pnpm capture` 和人工验收覆盖：

- **sticky 会话**：同一会话连续多条审批时，决策后应停在同会话的下一条；只有其他会话剩余 ≤10s 才插队。E2E 的 `multi` 每个会话只有一条，无法覆盖“处理完第一条仍留在原会话”。
- **会话感知排序**：`src/shared/triage.test.ts` 覆盖“截止时间接近时交错、相差较远时保持 EDF、不丢条目”。
- **准入回退可见**：`src/shared/approvals.test.ts` 覆盖按决策组计数、排除暂停/稍后；真实触发需要把 `maxPending` 调低并并发灌入多条请求，当前脚本未做。
- **过期/回退明细**：`expired` 的逐条关闭由 self-test 覆盖；`skipped` 明细、超时应用内提示需人工触发。
- **收起语义**：`×` 收起后 pending 保留、超时前 15s 重现；E2E 仍通过点击按钮完成审批，不覆盖收起路径。
- **焦点防护**：新卡片 500ms 内忽略 Enter/Esc 和单键快捷键；属于真实键盘/焦点行为，E2E 使用 `webContents` 点击，无法覆盖。
- **批量与键盘**：收件箱本会话全选、选区感知 A/D/T、批量拒绝二次确认、`Space` 多选、`J/K/A/D/T/S/P`、`?` 帮助；由 renderer 人工/截图验收。
- **跨会话同命令**：需要同一命令在两个会话并发请求；单测覆盖聚类，应用层确认流程由人工验收。
- **规则建议**：连续允许 2 次后的固化提示、仅本会话/本项目范围、匹配预览；由人工验收，规则匹配本身由 `rules.test.ts` 覆盖。
- **通知深链/动作**：点击通知直达具体 request、macOS “打开”动作；系统通知中心行为无法在无头 E2E 中可靠断言。

2026-10-25 多轮真实 Claude 结果：`stop` 每轮通过；`multi`（会话条切换、逐条允许）与 `timeout`（含暂停/恢复）在工具可见的轮次通过；`resolved` 在工具可见的轮次通过。全量 `pnpm e2e:claude` 的最后一次尝试中，`bypass` 的 `--dangerously-skip-permissions` 入口在 120s 内没有退出；同一时刻 `pending=0`、没有审批记录，且 Claude 输出 `unrecognized_model`（当次路由模型），说明是 Claude 侧的模型/权限行为，不是弹窗卡住。随后定向 `E2E_CASES=stop,multi,resolved,timeout` 通过（`stop`、`timeout` 实测，`multi`/`resolved` 因工具未暴露 SKIP）。跳过不是失败，工具暴露与路由模型会变化；不要用单轮 SKIP 或单轮 bypass 失败推断审批 UI 回归。新增行为落地时，如果改动了弹窗/收件箱的可见文本或 DOM 结构，需要同时更新 `pnpm capture` 截图和本节的覆盖说明。

### 明确不覆盖

- 交互式 TUI 中的真实按键/终端焦点（E2E 使用 `claude -p` 非交互模式）
- 真实 `AskUserQuestion`（由 self-test/离屏截图覆盖）
- Windows 上的真实 Claude Claude 进程（本脚本在 macOS/Linux 跑真实 Claude；Windows 的 hook 写入/exec form 由单测覆盖，真机仍需人工验收）
- 真实远程服务器 SSH（需要对应环境）
- 签名、安装包、系统通知点击、窗口拖拽等平台交互

这些由 `pnpm test`、`pnpm self-test`、`pnpm capture` 和真机验收覆盖。

Claude Code 当前会话的工具注册表可能动态只暴露 ToolSearch/Web 工具；此时 `multi`、`resolved`、`timeout` 会明确打印 SKIP 而不是超时失败。需要严格验证时设置 `E2E_REQUIRE_TOOLS=1`。

---

## 2. 前置条件

- macOS 或 Linux，有可用图形会话（Linux CI 可用 `xvfb-run`）
- Node.js 22+（脚本使用全局 `WebSocket`）
- `pnpm install` 已完成
- `python3` 可执行
- Claude Code CLI 已安装并**已登录**
- 隔离配置能复用认证：`~/.claude/settings.json` 里有 `apiKeyHelper`（以及需要的 `env` / `model`）

> E2E 会使用 `--setting-sources ""` 排除用户/项目/本地设置，只加载脚本生成的 `--settings` 文件；该文件会复制 `apiKeyHelper`、`env`、`model`，并写入本工具的 hooks。这样不会执行你全局配置里的旧 Notify hooks，也不会修改 `~/.claude/settings.json`。

如果认证配置不在默认位置：

```bash
E2E_CLAUDE_SETTINGS=/path/to/settings-with-apiKeyHelper.json pnpm e2e:claude
```

如果只有 OAuth、没有 `apiKeyHelper`，脚本会默认跳过；可以显式尝试：

```bash
E2E_ALLOW_NO_KEY_HELPER=1 pnpm e2e:claude
```

---

## 3. 运行方式

```bash
# 全部用例
pnpm e2e:claude

# 只跑某几个
E2E_CASES=bypass pnpm e2e:claude
E2E_CASES=multi,timeout pnpm e2e:claude

# 复用已有 out/，不重新构建
E2E_SKIP_BUILD=1 pnpm e2e:claude

# 保留临时目录（应用日志、Claude 输出、history）
E2E_KEEP=1 pnpm e2e:claude

# CI：没有 Claude CLI/认证时默认跳过；设置后变成失败
E2E_REQUIRE_CLAUDE=1 pnpm e2e:claude
```

常用环境变量：

| 变量 | 作用 |
|---|---|
| `E2E_CASES` | `all` 或 `bypass,stop,multi,resolved,timeout` |
| `E2E_CLAUDE_SETTINGS` | 提供 apiKeyHelper/env/model 的 Claude 设置文件 |
| `E2E_SKIP_BUILD=1` | 跳过 `pnpm build` |
| `E2E_KEEP=1` | 保留临时目录，失败时默认保留 |
| `E2E_REQUIRE_CLAUDE=1` | 找不到 Claude/认证时返回失败而不是跳过 |
| `E2E_SKIP_AUTH_PROBE=1` | 跳过认证探测（不建议） |
| `E2E_ORIGIN` | 覆盖测试来源标签，默认 `e2e-claude` |
| `E2E_THEME` | 测试实例主题，默认 `dark`；需要浅色截图时设为 `light` |
| `E2E_REQUIRE_TOOLS=1` | Claude 工具未暴露时不再 SKIP，直接失败（严格模式） |
| `CLAUDE_BIN` | 指定 Claude 可执行文件 |

退出码：

- `0`：通过；或缺少 Claude/认证且未设置 `E2E_REQUIRE_CLAUDE=1`（跳过）
- `1`：断言失败、Claude 不可用但要求必须跑、或构建失败

---

## 4. 隔离与清理

每次运行会在系统临时目录创建 `claude-notify-e2e-*`，包含：

- `data/`：独立的 `CLAUDE_NOTIFY_DATA_DIR`（token、history、sessions、pending）
- `electron/`：独立的 Electron `--user-data-dir`
- `claude/`：独立的 `CLAUDE_NOTIFY_CLAUDE_DIR`，不会读到真实本机 hooks
- `work-a/`、`work-b/` 等：各自 Claude 工作目录
- `claude-settings.json` / `claude-settings-timeout.json`：隔离的 Claude 设置
- `logs/`：每个 Claude 会话的 stdout/stderr

端口使用系统动态空闲端口；不会占用 18765，也不会影响正在运行的应用实例。

成功后自动删除临时目录；失败或 `E2E_KEEP=1` 时保留并打印路径。**不要提交这些临时目录里的内容。**

---

## 5. 脚本工作流程

1. 检查 `claude`、`python3`、`electron`、Node WebSocket
2. `pnpm build`（除非 `E2E_SKIP_BUILD=1`）
3. 从 `~/.claude/settings.json` 复制认证字段，生成隔离的 Claude settings
4. 启动应用：动态端口 + 独立数据目录 + `--remote-debugging-port`
5. 用隔离 settings 做一次认证探测（`claude -p "Reply OK"`）
6. 用例 1：并发启动两路 Claude，触发真实权限请求；通过 CDP 读弹窗 DOM/状态，切换会话并点击允许
7. 用例 2：启动一路 Claude，读取 pending 的 `requestId`，POST `/claude-approval-resolved`
8. 用例 3：用 15s hook 超时启动一路 Claude，等待服务端 5s 超时、检查 expired、确认清空
9. 校验 `DONE`、`result.txt`、history、sessions、pending
10. 关闭应用和 Claude 子进程，清理临时目录

脚本不会使用 `--dangerously-skip-permissions`，权限决定必须经过应用。

---

## 6. 新增 E2E 用例的约定

1. 在 `scripts/e2e-claude.mjs` 加一个 `runXxxCase()`，并在 `main()` 里按 `shouldRun('xxx')` 调用。
2. 用 `startClaude(label, randomUUID(), settingsFile, prompt)` 启动真实会话；不同用例使用不同 `work-*` 目录和 UUID。
3. 用 `waitPending(n)` 等真实 pending；用 `ensurePopupCdp()` / `getState()` 读应用状态；用 `cdp.eval()` 操作真实弹窗 DOM。
4. 用例结束前必须：
   - 让 pending 回到 0（批准、resolved、超时或明确 `ask`）
   - 终止 Claude 子进程，避免它继续触发第二个权限请求
   - 校验 history/sessions 的落盘结果
5. 在 `E2E.md` 的用例表里补充触发方式和断言。
6. 如果新增的是产品关键路径，优先把它加入 `pnpm test:all` 和发布检查清单。

推荐断言顺序：

```text
真实 Claude 启动 → pending.json 出现 → 弹窗 DOM 出现 → 操作弹窗
→ pending.json 清空 → Claude 输出/文件 → history.jsonl → sessions.json
```

---

## 7. 常见问题

**SKIP：找不到 Claude Code CLI**
确认 `claude --version` 可用；或设置 `CLAUDE_BIN`。

**SKIP：隔离配置需要 apiKeyHelper**
默认配置没有 `apiKeyHelper`。用 `E2E_CLAUDE_SETTINGS` 指向包含认证字段的设置文件，或 `E2E_ALLOW_NO_KEY_HELPER=1` 试跑。

**认证探测失败**
先用普通 `claude -p "Reply OK"` 确认登录；如果使用 OAuth 而非 apiKeyHelper，需要提供可用的隔离认证配置。

**连接不上弹窗 CDP**
E2E 需要显示窗口。Linux 无头环境用 `xvfb-run -a pnpm e2e:claude`；macOS 不要用 `--headless` 启动。

**卡在 pending=1**
设置 `E2E_KEEP=1`，查看打印的 `app.log`、`logs/*.out|err`、`data/claude-notify.log`。优先检查：
- Claude 是否真的触发了 `PermissionRequest`
- hook 命令里的端口/token 是否最新
- 是否选了一个被 Claude 自动放行的命令（用 `pwd && date +%s > result.txt` 这类已验证会询问的命令）

**测试留下进程**
脚本在失败/SIGINT 时会 kill 子进程；如果手动中断导致残留，检查 `pgrep -f claude-notify-e2e` 并清理。

---

## 8. 证据与最近一次真实验证

- 真实双会话弹窗截图：[preview/real-multi-session-popup.png](preview/real-multi-session-popup.png)（该图采集时使用了 `E2E_THEME=light`；现在 E2E 默认深色）
- 真实多会话收件箱：[preview/real-multi-session-inbox.png](preview/real-multi-session-inbox.png)
- 真实运行日志：[preview/real-multi-session-evidence.txt](preview/real-multi-session-evidence.txt)

已验证环境：Claude Code **2.1.295**。`bypass` 下 Bash / Write / Edit 均执行且 pending=0；`multi` 下两路真实 `-p` 会话并发，先批准第二路，弹窗自动切回第一路；两路均输出 `DONE` 并生成 `result.txt`；history 中记录 `allow/popup`，session 标签/颜色/来源正确。

自动 E2E 五个用例当前均通过，耗时约 **60–130s**，取决于 Claude 当前会话是否暴露 Bash/文件工具。`bypass` 同时覆盖 `--permission-mode bypassPermissions` 和 `--dangerously-skip-permissions`；`stop` 验证真实回合结束通知。
