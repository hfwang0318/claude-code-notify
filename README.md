# Claude Notify

[![Quality](https://github.com/hfwang0318/claude-code-notify/actions/workflows/quality.yml/badge.svg)](https://github.com/hfwang0318/claude-code-notify/actions/workflows/quality.yml)
[![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)]()
[![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows)](#下载)
[![macOS](https://img.shields.io/badge/macOS-supported-000000?logo=apple)](#下载)

Claude Code 的桌面审批与通知工具：把权限请求、`AskUserQuestion` 和通知转发到桌面，支持多会话队列、待审批收件箱、审批历史、本机接入与远端 SSH 部署。

应用使用 Electron + React + TypeScript；服务器端钩子仍然是零依赖 Python 脚本，部署到远端 `~/.claude/`，不要求服务器安装 Node。

## 界面截图

| 待审批收件箱 | 审批弹窗 |
|:---:|:---:|
| <img src="docs/screenshots/inbox.png" width="660" alt="待审批收件箱：多会话、风险标记、稍后提醒与批量操作" /> | <img src="docs/screenshots/popup.png" width="300" alt="审批弹窗：高风险确认、会话队列、倒计时暂停与稍后提醒" /> |
| **审批历史与统计** | **远程部署** |
| <img src="docs/screenshots/history.png" width="660" alt="审批历史：P50/P95、规则命中、风险与决策统计" /> | <img src="docs/screenshots/deploy.png" width="660" alt="远程部署：SSH 目标、指纹校验与回调验证" /> |

> 截图来自隔离的演示数据目录，不包含真实用户命令或服务器信息。更多历史版本截图见 [desktop/preview](desktop/preview)。

> Python/PySide6 版本已停止维护并从 `main` 移除。旧版本仍可从历史 tag / commit 中查看，但不再接收修复或发布。

## 下载

最新版本：[Desktop v0.4.0](https://github.com/hfwang0318/claude-code-notify/releases/tag/desktop-v0.4.0)

- Windows 免安装：`Claude-Notify-0.4.0-win-x64-portable.zip`
- Windows 安装版：`Claude.Notify.Setup.0.4.0.exe`
- macOS：`Claude.Notify-0.4.0-arm64.dmg`
- 校验：`SHA256SUMS-macos.txt` / `SHA256SUMS-windows.txt`

也可以直接打开 [Release 页面](https://github.com/hfwang0318/claude-code-notify/releases/tag/desktop-v0.4.0) 下载。

Windows 包未签名，SmartScreen 提示时选“更多信息 → 仍要运行”。macOS DMG 未签名/未公证，macOS 26/27 上不能直接启动，详见 [desktop/README.md](desktop/README.md)。打包版的自动更新需要签名；未签名 macOS 会自动回退到发布页。

## 快速开始

```bash
cd desktop
pnpm install
pnpm dev          # 开发模式
pnpm demo         # 构建后打开主窗口 + 演示审批
pnpm test         # 当前 152 个单测/集成测试，以实际输出为准
pnpm e2e:claude   # 真实 Claude Code 端到端（需已登录 Claude）
pnpm self-test    # HTTP 协议冒烟
pnpm local-app    # macOS：生成可双击的本机启动器
```

## 核心能力

- 权限审批：允许 / 拒绝（可附理由）/ 自定义 options / `permission_suggestions`
- `AskUserQuestion`：单选、多选、多问题、自由输入
- 相同请求合并：同会话同工具同参数的并行审批一次处理，收件箱支持多选批量拒绝/回退/低风险允许
- 稍后提醒：1/5/15 分钟后再弹，倒计时继续，不会改变超时语义
- 多会话：`origin + session_id`、标签/颜色、EDF 队列、会话条切换
- 待审批收件箱：按会话分组、搜索、风险筛选、批量回退、按会话静音（30 分钟 / 1 小时 / 4 小时 / 直到明天）
- 主窗口以待审批/历史/日志三个 tab 为主面板；状态、部署与设置以模糊模态覆盖在主窗口上
- 审批历史 `history.jsonl`、CSV/JSON 导出、统计（允许/拒绝/超时/P50/P95/规则命中）、可过滤日志
- 自动规则：按会话/项目/全局匹配，支持有效期、来源绑定和前缀/通配安全匹配
- 免打扰时段、通知类型区分（审批 / 等待输入 / 需要回答 / 完成）
- SessionEnd 会话结束态、恢复命令复制、计划审批与 MultiEdit/Write 预览
- 本机 hook 自动接入/版本自愈；远端 SSH 部署、SHA256 主机指纹、备份与恢复；多服务器目标管理
- 打包版自动更新：启动检查、手动下载/重启安装；未签名 macOS 回退到发布页
- 真实 Claude Code E2E：bypass 双入口、双会话、resolved、timeout

## 文档

- [desktop/README.md](desktop/README.md)：功能、开发、打包、平台表现
- [desktop/E2E.md](desktop/E2E.md)：真实 Claude Code 端到端测试
- [desktop/RELEASE.md](desktop/RELEASE.md)：发布与签名流程
- [desktop/CHANGELOG.md](desktop/CHANGELOG.md)：版本变更
- [AGENTS.md](AGENTS.md)：仓库 E2E 门禁
- [CONTRIBUTING.md](CONTRIBUTING.md)：开发与验证流程

## 更新已部署的钩子

升级桌面端后，在应用里重新部署即可（本机按钮或远端“部署并验证”）。部署会重新上传随包的 `claude_approval_hook.py` 并幂等合并 `settings.json`，不需要手动替换服务器文件。

本机 hook 版本过期时，应用启动会自动备份并升级；如果自动升级失败，会显示“本机 Hook 需要更新”横幅，可一键修复。
