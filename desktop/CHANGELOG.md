# Changelog

## 0.2.3 — 2026-10-22

### 修复

- Hook 输出增加事件名硬校验：`PermissionRequest` 只返回 `PermissionRequest`，`PreToolUse` 只返回 `PreToolUse`
- 事件不匹配时静默回退终端，避免 Claude 报 `hook returned incorrect event name`
- 旧 hook 会在应用启动时自动升级到版本 4；建议安装后完全退出再启动

### 测试

- 新增 hook 错误事件名回归测试；当前 55 个测试通过

## 0.2.2 — 2026-10-22

### 修复

- 服务端硬性拦截重复的 `AskUserQuestion` PermissionRequest：PreToolUse 问答之后不再弹第二个窗
- 兼容旧版/缺少 `CLAUDE_ASKUSER_CHANNEL` 的部署配置；重复请求直接回退终端
- 本机部署继续要求写入 `CLAUDE_ASKUSER_CHANNEL=pretooluse`，0.2.1 的启动自愈会修复旧配置

### 测试

- 新增服务端重复问答守卫测试；hook 测试验证 PreToolUse 通道存在时 PermissionRequest 不发送请求
- 当前 54 个测试通过

## 0.2.1 — 2026-10-22

### 修复

- 修复 Windows 升级后旧版本地 hook 仍在 bypass 权限下弹出 Bash/文件工具审批的问题
- 应用启动时检测本机 hook 版本过期，自动备份并重新写入当前 hook；失败时保留提示
- 主界面增加“本机 Hook 需要更新”显眼横幅，避免升级后忘记重新接入
- 设置页持续显示 hook 版本/更新入口

### 测试

- 真实 Claude Code E2E 新增 bypass 用例：覆盖 `--permission-mode bypassPermissions` 与 `--dangerously-skip-permissions`
- 同一用例强制调用 Bash、Write、Edit，断言 pending=0、工具真实执行、history 无审批记录
- 新增旧 hook 版本检测单元测试；当前 52 个测试通过

## 0.2.0 — 2026-10-22

### 多会话

- 会话身份（origin / session_id / prompt_id / tty / terminal）、自动标签、重命名与颜色持久化
- 弹窗会话条与完整队列，按剩余时间（EDF）排序；快超时排队项提示切换
- 主窗口待审批收件箱：按会话分组、批量回退、按会话静音
- `expired[]` 保留多条回退记录，弹窗/收件箱可逐条或全部确认
- 队列准入控制，避免排队超过剩余时间导致“看不见就超时”

### 审批与安全

- 修复超时提示“我知道了”无响应（补齐 `approval:acknowledge`）
- 修复弹窗无法拖动（增加 drag region，并记忆手动位置）
- 完整参数展开、命令风险高亮、Edit/Write diff、复制
- 高风险命令二次确认；焦点策略（首次/每条/从不）可配置；提示音聚合
- SSH 首次连接显示并固定 SHA256 主机指纹，指纹变化中止；部署错误中文映射
- Token 重新生成、停止服务、断开本机/服务器、恢复备份均二次确认
- 修复远端“仅勾选写入环境变量才写 rc”的行为

### 可观测性与部署

- 审批历史 `history.jsonl` 持久化、筛选与 CSV 导出
- 日志筛选/搜索/复制/打开/粘底暂停/5MB 轮转
- 部署目标列表、来源标签、预检回调连通性、移除服务器钩子、恢复服务器备份
- 启动时恢复本机接入状态与钩子版本；提供重新接入提示
- 崩溃/重启后提示上次未处理的审批数量（快照仅存最小元数据，权限 600）
- 网络设置：端口、监听范围、网卡选择、端口冲突横幅
- 深色/浅色/跟随系统主题；托盘/Dock 待审批角标；应用菜单与关于面板
- 设置面板新增字体样式（系统/圆体/衬线/等宽）与字号（小/标准/大/特大），主窗口/弹窗/设置同步缩放
- 首次使用 3 步引导；规则管理；版本检查
- 真实 Claude Code 2.1.295 双会话并发验证：权限请求、弹窗会话条切换、逐条批准、DONE 输出与 history/session 落盘
- 固化 `pnpm e2e:claude`：自动隔离端口/数据目录/Claude settings，覆盖双会话并发、resolved、真实超时；文档见 `E2E.md`

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
