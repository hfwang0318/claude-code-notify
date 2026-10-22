# Claude Notify

Claude Code 的桌面审批与通知工具：把权限请求、`AskUserQuestion` 和通知转发到本机桌面，支持本机接入与远端 SSH 一键部署。

0.2.0 起重点补上了多会话管理：会话身份/来源/终端标签、按剩余时间排序的队列、待审批收件箱、按会话静音、审批历史与可过滤日志。

仓库里现在有两套实现：

| 目录 | 技术栈 | 状态 |
|---|---|---|
| `desktop/` | Electron + React + TypeScript | 当前主版本，持续维护 |
| 仓库根目录 | Python + PySide6 | 旧版实现，保留用于对照 |

服务器端钩子始终是零依赖 Python 脚本，部署到远端 `~/.claude/`，不要求服务器安装 Node。

## 下载

最新版本：[Desktop v0.2.3](https://github.com/hfwang0318/claude-code-notify/releases/tag/desktop-v0.2.3)

- Windows 免安装：Release 里的 `Claude-Notify-0.2.3-win-x64-portable.zip`
- Windows 安装版：`Claude.Notify.Setup.0.2.3.exe`
- macOS：`Claude.Notify-0.2.3-arm64.dmg`

也可以直接打开 [Release 页面](https://github.com/hfwang0318/claude-code-notify/releases/tag/desktop-v0.2.3) 下载。

Windows 包未签名，SmartScreen 提示时选“更多信息 → 仍要运行”。macOS DMG 未签名/未公证，macOS 26/27 上不能直接启动，详见 [desktop/README.md](desktop/README.md)。

## 快速开始（Electron 版）

```bash
cd desktop
pnpm install
pnpm dev          # 开发模式
pnpm demo         # 构建后打开主窗口 + 演示审批
pnpm test         # 52 个单测/集成测试
pnpm e2e:claude   # 真实 Claude Code 端到端（需已登录 Claude）
pnpm self-test    # HTTP 协议冒烟
pnpm local-app    # macOS：生成可双击的本机启动器
```

## 文档

- [desktop/README.md](desktop/README.md)：功能、开发、打包、平台表现
- [desktop/E2E.md](desktop/E2E.md)：真实 Claude Code 端到端测试
- [desktop/RELEASE.md](desktop/RELEASE.md)：发布与签名流程
- [desktop/CHANGELOG.md](desktop/CHANGELOG.md)：版本变更

## 更新已部署的钩子

升级桌面端后，在应用里重新部署即可（本机按钮或远端「部署并验证」）。部署流程会重新上传随包的 `claude_approval_hook.py` 并幂等合并 `settings.json`，不需要手动替换服务器文件。

