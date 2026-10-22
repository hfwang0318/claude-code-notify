# Release Checklist

## 1. 版本与验证

- 更新 `desktop/package.json` 的 `version`
- `pnpm typecheck`
- `pnpm test`（当前 49 个测试）
- `pnpm e2e:claude`（真实 Claude Code：双会话 / resolved / timeout；没有 Claude 认证的 CI 会自动跳过）
- `pnpm self-test`
- `pnpm build`

## 2. macOS

产物：`release/Claude Notify-<version>-arm64.dmg`

签名 / 公证所需环境变量：

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
export CSC_LINK="/path/to/DeveloperIDApplication.p12"
export CSC_KEY_PASSWORD="p12-password"
pnpm dist:mac
```

`scripts/notarize.cjs` 会在签名后调用 `@electron/notarize`；没有凭据时自动跳过。

验证：

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Claude Notify.app"
spctl --assess --type execute --verbose=4 "release/mac-arm64/Claude Notify.app"
xcrun stapler validate "release/mac-arm64/Claude Notify.app"
```

注意：当前没有 Developer ID 证书。未签名 / ad-hoc 的 Electron 包在 macOS 26/27
上**不能直接启动**，DMG 只能作为检查产物。本机开发用：

```bash
pnpm local-app
open "Claude Notify Local.app"
```

该启动器依赖当前 checkout 和 `node_modules`，不能分发。

## 3. Windows

正式安装包在 windows-latest 构建，见 `.github/workflows/desktop-release.yml`：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm dist:win
```

产物：`release/Claude Notify Setup <version>.exe`（NSIS，x64）。

### 发布顺序

1. 确认版本号已更新，提交并推送 `feat/electron-desktop`
2. 创建并推送 annotated tag `desktop-v0.2.0`
3. workflow 会在 tag 上自动创建 GitHub Release（如果不存在），随后上传：
   - macOS `*.dmg` + `SHA256SUMS-macos.txt`
   - Windows `*Setup*.exe`、portable zip、`SHA256SUMS-windows.txt`
4. 如果 Release 已手动创建，workflow 会复用并 `--clobber` 上传产物

> GitHub 的 `gh` 命令在 workflow 内使用 `${{ github.token }}`；本地发布不需要登录 `gh`。
> 推送 tag 需要本机 GitHub SSH 或 HTTPS 凭据。

### 代码签名

通过 CI secrets 注入：

- `CSC_LINK`：pfx/base64 证书
- `CSC_KEY_PASSWORD`：证书密码

未签名时 SmartScreen 会提示“未知发布者”；测试包可点“更多信息 → 仍要运行”。

### 免安装 zip

从 `release/win-unpacked` 或 CI 安装包解出的 payload 打包，附带
`RUN-ME.bat`（输出 `run.log`）和 `README-PORTABLE.txt`。

## 4. 发布前人工验证

- [ ] macOS：弹窗在普通桌面、全屏应用、切换 Space 后可见
- [ ] macOS：Enter 允许 / Esc 交给终端 / 超时回退
- [ ] macOS：本机接入与远端 SSH 部署
- [ ] Windows 11：Acrylic 背景、标题栏控件不重叠、托盘图标
- [ ] Windows 11：焦点窗口定位
- [ ] Windows：安装包安装/卸载、开机自启、Toast 通知
- [ ] Windows：免安装 zip 直接运行
- [ ] 两端：字体可读性（0.1.2 起 +2px）
- [ ] 两端：Token 重新生成后重新部署提示
- [ ] 升级后重新部署能更新 `claude_approval_hook.py`

## 5. 产物

- macOS：`release/Claude Notify-<version>-arm64.dmg`
- Windows：`release/Claude Notify Setup <version>.exe`
- Windows 免安装：`Claude-Notify-<version>-win-x64-portable.zip`
- 校验：`SHA256SUMS-macos.txt` / `SHA256SUMS-windows.txt`
- 以上产物由 `.github/workflows/desktop-release.yml` 自动上传到对应 Release
- 不要提交 `release/`、`out/`、`node_modules/`
