# Claude Notify · Electron + React + TypeScript

Python/PySide6 版本的完整技术栈迁移。桌面端已经替换为 Electron + React，
服务器端钩子仍然使用零依赖 Python 脚本（部署到远端 `~/.claude/`，不要求用户装 Node）。

## 运行

```bash
cd desktop
pnpm install
pnpm dev        # Vite + Electron 开发模式
pnpm demo       # 构建后打开主窗口 + 演示审批弹窗
pnpm capture    # 离屏截图：main / popup / popup-question
pnpm self-test  # 协议冒烟：health、401、审批、问答、建议、resolved
pnpm test       # HTTP 集成 + settings/env + 本机接入（25 个）
```

如果 shell 里带 `ELECTRON_RUN_AS_NODE=1`，用 `env -u ELECTRON_RUN_AS_NODE pnpm dev`。

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
- 超时后弹窗保留“已回退终端”提示，需点“我知道了”或按 Enter/Esc 关闭

### 部署与凭证

- `ssh2` 真实 SSH 部署：密码 / 私钥 / 私钥密码
- 上传所选钩子、删除未选钩子、`chmod 755`
- `settings.json` 备份 + 幂等合并（清除本工具旧条目，保留第三方 hooks）
- 可选把 Token 写入 bash / zsh / csh / fish 的 rc 文件（幂等标记块）
- 部署后验证 `python3` 可执行钩子，并从服务器反向 `curl /health`
- 部署缓存（非敏感字段）+ `safeStorage`（macOS Keychain / Windows DPAPI）保存密码
- 部署前「测试连接」：只连 SSH 并读取 `$HOME`，不写任何文件
- **本机接入**：写入 `~/.claude/` 钩子 + `claude_notify_config.json`，合并本机
  `settings.json`；POSIX 用 shell form，Windows 用 exec form（解释器绝对路径）
- Token 复用并持久化到 `~/.claude-notify/token`，重新生成会立即更新 HTTP 服务并提示重新部署

### 桌面能力

- 本机/远端部署都支持弹窗与通知两种模式；本机模式在偏好里切换并持久化

- 单实例锁、托盘菜单、开机自启、系统通知、隐藏到托盘
- 日志同时写 `~/.claude-notify/claude-notify.log`
- macOS `vibrancy: 'hud'`；Windows 11 22H2+ `backgroundMaterial: 'acrylic'` + 隐藏标题栏
- Windows 托盘使用 `resources/app.ico`；已设置 AppUserModelID

## 验证

- `pnpm test`：25 个测试（HTTP 401 / 411 / 413 / 去重 / 长轮询 / 断开取消 / 并发队列 / resolved，settings 合并，本机接入，Windows exec form）
- `pnpm self-test`：health、allow、question、suggestion、resolved、404
- Docker Alpine sshd e2e：密码认证、私钥 + passphrase 认证、popup 部署、notify 重部署、反向 `/health`、幂等 bash 环境变量块
- 打包后的 `.app` 也跑通了同一套 SSH e2e
- macOS 全屏覆盖：`NSPanel` 弹窗在主窗口全屏时仍可见，点击与 Esc 均正常
- 超时：返回 `timeout`，主进程状态进入 expired，弹窗显示“已回退终端”
- Windows NSIS 安装包已解包检查，包含 `resources/hooks`、`app.asar`、`app.ico`、托盘图标

## 尚未完成

- Windows 真机安装/运行验证（Acrylic、标题栏 overlay、焦点窗口定位）
- Windows NSIS 安装包已在 macOS 构建，但尚未在 Windows 上安装验证
- macOS Developer ID 签名 / 公证；Windows 代码签名
- 远端 SSH 部署已在 Docker sshd 上 e2e；真实服务器/防火墙场景待测
- 非全屏的多 Space 切换人工验证（全屏覆盖已用 NSPanel 验证通过）
- 历史记录持久化、日志轮转

## 结构

```
src/main/index.ts         窗口、托盘、IPC、生命周期
src/main/server.ts        HTTP 服务、审批注册表、去重
src/main/protocol.ts      payload 归一化、suggestion 标签
src/main/config.ts        Token、部署缓存、safeStorage
src/main/deploy/settings.ts  settings.json 合并 / env block
src/main/deploy/ssh.ts    ssh2 部署
src/main/store.ts         应用状态与日志
src/preload/index.ts      contextBridge API
src/renderer/             React UI（App / Popup / DeployDialog）
src/shared/               主进程与渲染进程共享类型
resources/hooks/          随包分发的服务器端钩子
```

## 打包

```bash
pnpm pack:mac   # release/mac-arm64/Claude Notify.app（已验证可启动）
pnpm dist:mac   # dmg
pnpm dist:win   # NSIS（在 Windows 上构建；arm64 macOS 无 Rosetta 时 makensis 会失败）
```

`electron-builder.yml` 已包含 `extraResources`（hooks、tray icon、app.ico）、
macOS entitlements、Windows NSIS 配置，以及可选公证钩子 `scripts/notarize.cjs`。

- 公证：设置 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`；
  未设置时自动跳过（本地构建用 `SKIP_NOTARIZE=1`）。
- Windows 签名：在 CI 里提供代码签名证书（`CSC_LINK` / `CSC_KEY_PASSWORD`）。
- Windows x64 unpacked 已在本机验证打包内容（`release/win-unpacked`），
  NSIS x64 安装包已生成：`release/Claude Notify Setup 0.1.0.exe`（108MB，未签名）
- arm64 macOS 构建 NSIS 需要原生 `makensis`（Homebrew）绕过 x86 版 makensis；
  正式发布仍建议使用 `.github/workflows/desktop-release.yml` 的 windows-latest 构建

发布流程见 [RELEASE.md](RELEASE.md)。

## 平台表现

| 平台 | 背景效果 | 标题栏 |
|---|---|---|
| macOS | `vibrancy: 'hud'` + 透明窗口，桌面真实模糊透入 | `hiddenInset` + 红绿灯 |
| Windows 11 22H2+ | `backgroundMaterial: 'acrylic'` + 透明窗口 | `hidden` + `titleBarOverlay` |
| Windows 10 / 更早 | 纯色 `#0a0a0c` 回退 | 同上 |

Windows Acrylic 受系统「透明效果」和省电模式影响；关闭后退化为纯色。
`CLAUDE_NOTIFY_OPAQUE=1` 可强制关闭透明做对比。
