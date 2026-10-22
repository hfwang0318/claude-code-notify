# Changelog

## 0.1.2 — 2026-10-22

- 全局字体增大 2px，覆盖主窗口、部署对话框、审批/问答弹窗和超时提示
- 主窗口高度 740 → 800，避免底部说明被裁切
- 继承 0.1.1 的 `bypassPermissions` 钩子修复
- Windows 安装包由 windows-latest CI 构建；新增免安装 zip

## 0.1.1 — 2026-10-21

- 修复 Claude Code 2.1.303 在 `bypassPermissions` / `dontAsk` 下仍弹审批的问题
- `claude_approval_hook.py` 检查 `permission_mode`，无需审批时直接退出
- Windows 安装包改为 Windows CI 构建，避免 macOS 交叉构建的 NSIS 兼容问题
- 发布流程改为“升级后重新部署”，不再提供手动替换脚本

## 0.1.0 — 2026-10-21

- Electron + React + TypeScript 版本首次发布
- HTTP 审批协议、长轮询、去重、超时、resolved
- 审批 / 问答 / 通知弹窗，本机与 SSH 部署
- macOS NSPanel 全屏覆盖、Windows 11 Acrylic 配置
- macOS DMG、Windows NSIS、macOS 本机启动器（仅本机）
