# Claude Notify · Electron + React + TypeScript

Python/PySide6 版本的完整技术栈迁移。桌面端已经替换为 Electron + React，
服务器端钩子仍然使用零依赖 Python 脚本（部署到远端 `~/.claude/`，不要求用户装 Node）。

当前版本 **0.6.0**，下载：[GitHub Release](https://github.com/hfwang0318/claude-code-notify/releases/tag/desktop-v0.6.0)。

## 运行

```bash
cd desktop
pnpm install
pnpm dev        # Vite + Electron 开发模式
pnpm demo       # 构建后打开主窗口 + 演示审批弹窗
pnpm capture    # 离屏截图：onboarding / main / status / inbox / history / logs / settings / settings-reminder / deploy / deploy-dialog / popup*
pnpm self-test  # 协议冒烟：health、401、审批、问答、建议、resolved
pnpm test       # HTTP 集成 + settings/env + 会话/规则/协议（当前 169 个，以 pnpm test 输出为准）
pnpm e2e:claude # 真实 Claude Code 双会话/resolved/超时（见 E2E.md）
```

如果 shell 里带 `ELECTRON_RUN_AS_NODE=1`，用 `env -u ELECTRON_RUN_AS_NODE pnpm dev`。

离屏/CI 可用 `CLAUDE_NOTIFY_PORT`、`CLAUDE_NOTIFY_THEME=dark|light`、`CLAUDE_NOTIFY_DATA_DIR` 隔离端口、主题和 `~/.claude-notify` 数据目录。

## 已迁移功能

### HTTP 协议（与 Python 版对齐）

- `GET /health`
- `POST /claude-notify`：3 秒同会话同类型去重，1 小时清理
- `POST /claude-approval`：长连接挂起，返回 `{status, decision, index?, answers?}`
- `POST /claude-approval-resolved`：终端已处理时关闭弹窗，返回 `resolved / not_found`
- Bearer Token 常量时间比较、1MB 限制、Content-Length / UTF-8 / JSON 根对象校验
- 超时 5–600 秒，缺省 50 秒；客户端断开回退 `cancelled`

### 审批弹窗

- 权限审批：允许 / 拒绝 / 自定义 options / `permission_suggestions`（按原始对象 echo index）
- AskUserQuestion：单选、多选、多问题、自由输入，返回 `answers: [{question, selected, text}]`
- 队列计数、倒计时、超时回退、Enter / Esc、动态高度、置顶与跨 Space
- 倒计时、暂停/继续与“稍后 5 分钟”固定在卡片底部；会话条/队列显示“已暂停”
- 卡片顶部会显示“余量”（剩余时间 − 按历史估算的处理时间），低余量提前标红
- **相同请求合并**：同会话、同工具、同参数的并行审批显示为一张卡片，一次允许/拒绝/交给终端应用到整组
- **稍后提醒**：1/5/15 分钟后重新弹出；倒计时继续，不改变超时语义；超过剩余时间时禁用
- **拒绝理由**：拒绝时可填写说明或点快捷理由，通过 hook 的 `deny.message` 回传给 Claude
- 高风险卡片显示风险原因、二次确认；长 diff 先显示文件数 / +N / −N 摘要，可展开全文
- **收起**：`×` 只收起弹窗，审批仍在队列并在超时前 15s 重现；“交给终端”仍是显式按钮
- 新卡片出现后的 500ms 内忽略 Enter/Esc 和单键快捷键，避免抢焦点时误批
- **规则建议**：连续允许同一命令后可一键固化；支持“仅本会话 / 本项目”、有效期和匹配预览
- **跨会话相同命令**：提示其他会话在等同一条命令，确认后可一次允许全部
- 超时/队列回退有独立明细面板，可查看每条记录后再确认；不再只能一键“全部知道了”
- `bypassPermissions` / `dontAsk` 下钩子直接跳过，不产生幽灵审批；0.2.1 起启动时自动备份并升级过期 hook
- 回合结束通过 Stop hook 发送“已完成”通知；弹窗模式显示应用内完成弹窗，通知模式发送系统通知
- ExitPlanMode 允许时回传 `updatedInput + setMode`，兼容 Claude Code 2.1.28x 的计划审批对话框

### 多会话与待审批收件箱

- 会话身份：`origin + session_id` 作为 key，附带 `prompt_id`、tty、终端程序、项目路径；
  新会话默认用**第一条任务摘要**命名（最多 22 字），也可在收件箱或弹窗里重命名，颜色稳定并持久化到 `sessions.json`
- `/new` 会生成新的 `session_id`，因此新会话会获得新的名字/短码/颜色，和关闭后重新打开 Claude 一致；
  同一会话内换主题只更新任务行，不重命名
- 弹窗顶部是会话身份条：项目头像 + 会话色脊、稳定短码（`session_id` 前 4 位）、
  主机 · 终端 · 分支 · 短路径，以及从 transcript 提取的**当前任务摘要**；没有任务摘要时按同项目 `#1/#2` 编号
- 队列按**会话感知的 EDF**排序，不是简单 FIFO；决策后停留在当前会话，只有其他会话剩余 ≤10s 时才插队
- 会话条单行显示名称、组数、暂停与截止时间，最多展示 3 个，其余用 `+N` 打开队列；当前会话始终可见
- 弹窗显示“N 个会话 · M 条待审批”和按会话分组的完整队列；队列支持搜索、高风险/问答筛选、J/K/A/D/T/S/P 键直接决策
- 键盘：`⌘/Ctrl + 1–9` 切会话，`⌘/Ctrl + ↑/↓` 切同一会话的多条请求；`?` 打开快捷键帮助；点击会话名可重命名
- 主窗口待审批收件箱：按会话分组、显示任务/分支，直接允许/拒绝/交给终端、按会话批量回退、静音提醒；
  支持多选批量拒绝（二次确认）、低风险批量允许（二次确认）、本会话全选、选区感知的 A/D/T、按截止/按余量排序
- 收件箱/弹窗/托盘支持“暂停全部/继续全部”和“全部静音”；`Space` 多选，处理完一条后停在相邻条目
- 超时 `expired[]` 与队列准入 `skipped[]` 都保留最近 20 条，弹窗/收件箱可查看明细并逐条确认
- 队列准入按**决策组**计数，排除暂停/稍后项；因过载直接回退的请求会显示“未弹出”记录，不再静默消失
- 多服务器：部署时写入 `origin` 来源标签，弹窗/收件箱/历史/日志/系统通知/托盘都会显示来源与任务

### 部署与凭证

- `ssh2` 真实 SSH 部署：密码 / 私钥 / 私钥密码
- 上传所选钩子、删除未选钩子、`chmod 755`
- `settings.json` 备份 + 幂等合并（清除本工具旧条目，保留第三方 hooks）；支持移除服务器钩子与恢复上一个备份
- 可选把 Token 写入 bash / zsh / csh / fish 的 rc 文件（幂等标记块）
- 部署后验证 `python3` 可执行钩子，并从服务器反向 `curl /health`；测试连接会同时预检回调连通性
- SSH 首次连接显示 SHA256 主机指纹并固定到 `known_hosts.json`；指纹变化会中止并提示，不静默信任
- 部署错误映射为可操作中文提示（DNS/端口/认证/私钥密码/超时）
- 部署缓存（非敏感字段）+ `safeStorage`（macOS Keychain / Windows DPAPI）保存密码
- 部署前「测试连接」：只连 SSH 并读取 `$HOME`，不写任何文件
- **本机接入**：写入 `~/.claude/` 钩子 + `claude_notify_config.json`，合并本机
  `settings.json`；POSIX 用 shell form，Windows 用 exec form（解释器绝对路径）
- Token 复用并持久化到 `~/.claude-notify/token`，重新生成会立即更新 HTTP 服务并提示重新部署

### 自动更新

- `electron-updater` + GitHub Releases（`publish` 配置在 `electron-builder.yml`）
- 打包版启动 5 秒后检查（可在设置关闭）
- **Windows NSIS 安装版**：下载 `latest.yml` 对应的 Setup，下载完成重启安装
- **免安装版**：检测 `RUN-ME.bat` / `portable.marker` / `PORTABLE_EXECUTABLE_DIR`，只下载对应的新 zip 到系统下载目录并打开文件夹，不自动替换当前目录
- macOS 需要 Developer ID 签名/公证才能安装更新；未签名时自动回退到发布页
- 发布流程会生成并上传 `latest-mac.yml` / `latest.yml`，macOS 同时产出 zip（更新包）

### 桌面能力

- 本机/远端部署都支持弹窗与通知两种模式；切换模式会提示重新接入/部署，不再假装“立即生效”
- 单实例锁、托盘菜单、开机自启、系统通知、隐藏到托盘；托盘/Dock 按决策组显示待审批数，tooltip 给出组/条/会话/最早截止
- 系统通知聚合最近 1.2 秒内到达的会话，显示最早截止时间，点击可直达具体请求；macOS 通知带“打开”动作；审批提醒与回合完成通知都支持按会话静音，并遵循“系统通知”总开关
- 深色 / 浅色 / 跟随系统主题；浅色模式使用不透明窗口保证对比度
- 字体样式（系统 / 圆体 / 衬线 / 等宽）与字号（小 / 标准 / 大 / 特大），主窗口、设置面板和审批弹窗同步生效
- 首次使用引导；主窗口以待审批 / 历史 / 日志三个 tab 为主信息面板，标题栏只保留“状态 / 部署 / 设置 / 隐藏到托盘”；状态、部署与设置以模糊模态覆盖在主窗口上，部署页把本机接入与远程服务器部署并列呈现，状态页只保留服务、连接凭证和运行诊断，设置页新增“提醒”分类（位置 / 焦点 / 模式 / 超时）
- 日志支持级别筛选、搜索、复制、清空、打开文件、粘底/暂停；文件超过 5MB 自动轮转
- 崩溃/重启后提示上次未处理的审批数量；数据文件权限 600
- 审批历史持久化到 `history.jsonl`，可按会话/项目/工具/结果筛选，导出 CSV/JSON；
  提供允许/拒绝/超时、P50/P95 响应、规则命中和风险统计，支持详情面板与命令复制
- 通知支持免打扰时段，审批/等待输入/需要回答/完成使用不同标题；按会话静音支持 30 分钟/1 小时/4 小时/直到明天
- SessionEnd 会话结束态、30 分钟自动清理、`claude --resume` 命令复制
- ExitPlanMode 计划正文预览；MultiEdit/Write 多段 diff 与“打开文件”
- 自动更新：安装版启动检查、下载、重启安装；免安装版下载新 zip 到下载目录，不自动替换；未签名 macOS 回退到发布页
- 自动规则：按会话/项目/全局匹配工具与命令，直接允许；支持 1 小时/24 小时/永久有效期、来源绑定、
  规则命中审计；前缀/通配规则不会命中包含 shell 连接符的复合命令；高风险命令永不自动应用
- 日志同时写 `~/.claude-notify/claude-notify.log`
- macOS `vibrancy: 'hud'`；Windows 11 22H2+ `backgroundMaterial: 'acrylic'` + 隐藏标题栏
- Windows 托盘使用 `resources/app.ico`；已设置 AppUserModelID
- 主窗口默认 1080×820，支持缩放

## 下载、安装与升级

- Windows 免安装：Release 里的 `Claude-Notify-0.6.0-win-x64-portable.zip`
- Windows 安装版：`Claude.Notify.Setup.0.6.0.exe`（windows-latest CI 构建）
- macOS：`Claude.Notify-0.6.0-arm64.dmg`（未签名/未公证）

Windows 未签名，SmartScreen 选“更多信息 → 仍要运行”。macOS DMG 在 macOS 26/27
上不能直接启动；本机开发请用 `pnpm local-app` 生成启动器。

**升级已部署的服务器**：安装/解压新版本后，在应用里重新执行部署即可
（本机按钮或远端「部署并验证」）。部署会重新上传随包的钩子并幂等合并
`settings.json`，不需要手动替换服务器文件。

## 验证

- `pnpm test`：当前 169 个测试，以 `pnpm test` 输出为准（HTTP 401 / 411 / 413 / 去重 / 长轮询 / 断开取消 / 并发队列 / resolved / 停止服务、body 超时、回调异常、SSH 超时/取消、settings 合并与递归移除、本机接入、Windows exec form、会话身份/任务摘要/短码/同项目编号/倒计时暂停/风险/规则/协议、历史导出、通知策略、部署漂移、弹窗底部锚点、远程 Python 语法验证、完成弹窗策略）
- `pnpm self-test`：health、allow、question、suggestion、resolved、404、超时、回退确认、历史/会话落盘
- `pnpm e2e:claude`：真实 Claude Code 2.1.295 bypass（两种入口）、Stop 回合通知、双会话并发、终端已处理、真实超时回退；工具未暴露时明示 SKIP，约 60–130s
- E2E 使用隔离端口/数据目录/Claude settings，不修改 `~/.claude/settings.json`；详见 [E2E.md](E2E.md)
- 改动 hooks / server / Popup / 通知 / 部署后必须跑 `pnpm e2e:claude`；没有 Claude 认证时记录 SKIP（与 [AGENTS.md](../AGENTS.md) 一致）
- SSH 部署目前由单测/人工验证覆盖；真实服务器/防火墙场景仍需人工验收，仓库中没有对应的自动化脚本
- macOS 全屏覆盖：`NSPanel` 弹窗在主窗口全屏时仍可见，点击与 Esc 均正常
- 超时：返回 `timeout`，进入 `expired[]`，弹窗/收件箱显示“已回退终端”，确认后清除
- 真实 Claude Code 2.1.295 双会话：`--settings` 隔离 + `--permission-mode default`，两路 `PermissionRequest` 同时到达；弹窗显示 2 个会话/2 条，先批准 H 后自动切到 G；两路均输出 `DONE` 并写入 `result.txt`
- 多会话：EDF 排序、会话条/队列切换、按会话静音、收件箱分组在离屏截图与真实弹窗中验证
- Windows CI 构建 0.1.2 安装包，并解包检查 hooks / asar / 图标
- Windows 安装包由 windows-latest 原生构建，不再使用 macOS 交叉构建

## 尚未完成

- Windows 真机安装/运行验证（Acrylic、标题栏 overlay、焦点窗口定位）
- macOS Developer ID 签名 / 公证；Windows 代码签名（macOS 自动更新安装依赖签名）
- 远端 SSH 部署目前由单测/人工验证覆盖；真实服务器/防火墙场景仍需人工验收
- 非全屏的多 Space 切换人工验证（全屏覆盖已用 NSPanel 验证通过）
- Windows NSIS 自动更新的真机升级验证；portable zip 的“下载新 zip + 手动替换”流程需真机验收
- 主进程 `index.ts` 的 controller 完整拆分（目前先拆出了 shared 逻辑与 auto-update/update 模块）

## 结构

```
src/main/index.ts         窗口、托盘、菜单、IPC、通知、生命周期
src/main/sessions.ts      会话注册表与标签持久化
src/main/history.ts       审批历史持久化 / CSV 导出
src/main/net.ts           网卡枚举与端口探测
src/main/update.ts        GitHub Release 版本检查
src/main/server.ts        HTTP 服务、审批注册表、去重
src/main/protocol.ts      payload 归一化、suggestion 标签
src/main/config.ts        Token、部署缓存、safeStorage
src/main/deploy/settings.ts  settings.json 合并 / env block
src/main/deploy/ssh.ts    ssh2 部署
src/main/store.ts         应用状态与日志
src/preload/index.ts      contextBridge API
src/renderer/             React UI（App / Popup / Inbox / HistoryPanel / LogPanel / Preferences / DeployDialog）
src/shared/               类型、会话/风险/规则纯函数与测试
resources/hooks/          随包分发的服务器端钩子
scripts/e2e-claude.mjs    真实 Claude E2E 编排（应用 + Claude + CDP）
E2E.md                    E2E 用例、隔离机制、排查与新增用例约定
```

## 打包

```bash
pnpm pack:mac   # release/mac-arm64/Claude Notify.app（未签名，macOS 26/27 不能直接启动）
pnpm dist:mac   # dmg
pnpm dist:win   # NSIS（在 Windows / CI 上构建；本地 arm64 macOS 需原生 makensis）
pnpm local-app  # macOS 本机双击启动器（依赖 node_modules，不可分发）
```

`electron-builder.yml` 已包含 `extraResources`（hooks、tray icon、app.ico）、
macOS entitlements、Windows NSIS 配置，以及可选公证钩子 `scripts/notarize.cjs`。

- 公证：设置 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`；
  未设置时自动跳过（本地构建用 `SKIP_NOTARIZE=1`）。
- Windows 签名：在 CI 里提供代码签名证书（`CSC_LINK` / `CSC_KEY_PASSWORD`）。
- Windows 安装包由 `.github/workflows/desktop-release.yml` 在 windows-latest 构建；
  tag 触发后会直接把 `release/*Setup*.exe` 上传到对应 Release（Release 需先存在）
- 本地 arm64 macOS 构建 NSIS 需要原生 `makensis`（Homebrew）绕过 x86 版；
  正式发布使用 CI，不依赖本机 makensis

发布流程见 [RELEASE.md](RELEASE.md)。

## 平台表现

| 平台 | 背景效果 | 标题栏 |
|---|---|---|
| macOS | 深色：`vibrancy: 'hud'` + 透明窗口；浅色：不透明窗口保证对比度 | `hiddenInset` + 红绿灯 |
| Windows 11 22H2+ | `backgroundMaterial: 'acrylic'` + 透明窗口 + 半透明 shell + 12px 圆角（深/浅色均生效） | `hidden` + `titleBarOverlay` |
| Windows 10 / 更早 | 纯色 `#0a0a0c` 回退（系统不支持 Electron acrylic） | 同上 |

Windows Acrylic 受系统「透明效果」和省电模式影响；关闭后退化为纯色。
`CLAUDE_NOTIFY_OPAQUE=1` 可强制关闭透明和 acrylic 做对比；Windows 最大化时自动取消 CSS 圆角。
