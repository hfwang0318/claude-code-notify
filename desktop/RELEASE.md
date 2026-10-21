# Release Checklist

## 1. 版本与验证

- 更新 `package.json` 的 `version`
- `pnpm typecheck`
- `pnpm test`（当前 25 个测试）
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

`scripts/notarize.cjs` 会在签名完成后调用 `@electron/notarize`；没有凭据时自动跳过。

发布前验证：

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Claude Notify.app"
spctl --assess --type execute --verbose=4 "release/mac-arm64/Claude Notify.app"
xcrun stapler validate "release/mac-arm64/Claude Notify.app"
```

本地无凭据构建用于自测时：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false SKIP_NOTARIZE=1 pnpm pack:mac
```

注意：ad-hoc 签名会被 Gatekeeper 拒绝，只能直接运行二进制，不能作为正式分发件。

## 3. Windows

正式构建在 Windows runner 上执行（见 `.github/workflows/desktop-release.yml`）：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm dist:win
```

产物：`release/Claude Notify Setup <version>.exe`（NSIS，x64）。

代码签名证书通过 CI secrets 注入：

- `CSC_LINK`：pfx/base64 证书
- `CSC_KEY_PASSWORD`：证书密码

没有签名时 SmartScreen 会提示未知发布者，正式发布前必须签名。

arm64 macOS 本地构建 NSIS 需要原生 `makensis`（Homebrew），
否则 electron-builder 下载的 x86_64 makensis 会报 `Bad CPU type`。

## 4. 发布前人工验证

- [ ] macOS：弹窗在普通桌面、全屏应用、切换 Space 后可见
- [ ] macOS：Enter 允许 / Esc 交给终端 / 超时回退
- [ ] macOS：本机接入与远端 SSH 部署
- [ ] Windows 11：Acrylic 背景、标题栏控件不重叠、托盘图标
- [ ] Windows 11：焦点窗口定位
- [ ] Windows：安装包安装/卸载、开机自启、Toast 通知
- [ ] 两端：Token 重新生成后重新部署提示

## 5. 产物

- macOS：`release/Claude Notify-<version>-arm64.dmg`
- Windows：`release/Claude Notify Setup <version>.exe`
- 不要提交 `release/`、`out/`、`node_modules/`
