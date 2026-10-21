import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray
} from 'electron'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces, release } from 'node:os'
import { join } from 'node:path'
import type {
  ApprovalExtra,
  ApprovalItem,
  AppState,
  DeployCacheView,
  DeployFormConfig,
  DeployResult,
  LogLevel,
  PopupPosition,
  SecurityInfo
} from '../shared/types'
import {
  appDataDir,
  decryptSecret,
  encryptSecret,
  loadDeployCache,
  loadOrCreateToken,
  loadUiConfig,
  saveDeployCache,
  saveUiConfig,
  saveToken,
  secureStorageAvailable,
  secureStorageLabel
} from './config'
import { deployLocal, detectLocalDeploy } from './deploy/local'
import { deployToServer, testSshConnection } from './deploy/ssh'
import { NotifyServer } from './server'
import { Store } from './store'

const APP_NAME = 'Claude Notify'
const PORT = 18765
const POPUP_WIDTH = 540
const POPUP_HEIGHT = 470

const isCapture = process.argv.includes('--capture')
const isSelfTest = process.argv.includes('--self-test')
const isDeployTest = process.argv.includes('--self-test-deploy')
const isDemo = process.argv.includes('--demo-popup')
const headless = (isCapture || isSelfTest || isDeployTest) && !isDemo

app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId('com.claude-notify.app')

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
}


let store: Store
let server: NotifyServer
let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
let popupWindow: BrowserWindow | null = null
let popupReady = false
const localApprovals = new Map<string, (decision: string) => void>()
let logFile = ''

function localIp(): string {
  const interfaces = networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function log(level: LogLevel, message: string): void {
  store.log(level, message)
  try {
    if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message}\n`)
  } catch {
    // logging must never break the app
  }
}

function broadcast(state: AppState): void {
  for (const window of [mainWindow, popupWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('state:update', state)
  }
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function loadRenderer(window: BrowserWindow, hash: string): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return window.loadURL(`${devUrl}#${hash}`)
  return window.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

function windowsBuild(): number {
  if (process.platform !== 'win32') return 0
  return Number(release().split('.')[2] || 0)
}

function createMainWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(1120, area.width - 40)
  const height = Math.min(740, area.height - 40)
  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'
  // Windows 11 22H2+ supports the system Acrylic material. Older builds fall
  // back to an opaque charcoal window so the layout stays readable.
  const forceOpaque = process.env.CLAUDE_NOTIFY_OPAQUE === '1'
  const useAcrylic = isWindows && !forceOpaque && windowsBuild() >= 22621
  const useGlass = !forceOpaque && (isMac || useAcrylic)
  console.log('[window] material', {
    platform: process.platform,
    build: windowsBuild(),
    acrylic: useAcrylic,
    glass: useGlass
  })
  const window = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: 1000,
    minHeight: 660,
    show: false,
    title: APP_NAME,
    backgroundColor: useGlass ? '#00000000' : '#0a0a0c',
    transparent: useGlass,
    vibrancy: isMac ? 'hud' : undefined,
    visualEffectState: 'active',
    backgroundMaterial: useAcrylic ? 'acrylic' : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 21 } : undefined,
    titleBarOverlay: isWindows
      ? { color: '#00000000', symbolColor: '#d4d4d8', height: 58 }
      : undefined,
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => {
    if (!headless) window.show()
  })
  window.on('closed', () => {
    mainWindow = null
  })
  void loadRenderer(window, 'main')
  return window
}

let focusBoundsCache: { at: number; bounds: Electron.Rectangle | null } = {
  at: 0,
  bounds: null
}

function foregroundWindowBounds(): Electron.Rectangle | null {
  if (process.platform !== 'win32') return null
  if (Date.now() - focusBoundsCache.at < 1500) return focusBoundsCache.bounds
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CNForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$h = [CNForeground]::GetForegroundWindow()
$r = New-Object CNForeground+RECT
[CNForeground]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ("{0},{1},{2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
`
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: 2000, windowsHide: true }
    )
    const match = (result.stdout || '').match(/(-?\d+),(-?\d+),(-?\d+),(-?\d+)/)
    if (!match) return null
    const [left, top, right, bottom] = match.slice(1).map(Number)
    const bounds = {
      x: Math.min(left, right),
      y: Math.min(top, bottom),
      width: Math.abs(right - left),
      height: Math.abs(bottom - top)
    }
    if (bounds.width < 50 || bounds.height < 50) return null
    focusBoundsCache = { at: Date.now(), bounds }
    return bounds
  } catch {
    return null
  }
}

function popupDisplay(): Electron.Display {
  const position = store.get().prefs.position
  if (position === 'primary') return screen.getPrimaryDisplay()
  if (position === 'focus') {
    const bounds = foregroundWindowBounds()
    if (bounds) return screen.getDisplayMatching(bounds)
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function popupBounds(): { x: number; y: number } {
  const display = popupDisplay()
  const area = display.workArea
  return {
    x: Math.round(area.x + area.width - POPUP_WIDTH - 22),
    y: Math.round(area.y + area.height - POPUP_HEIGHT - 22)
  }
}

function createPopupWindow(): BrowserWindow {
  const bounds = popupBounds()
  const window = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    x: bounds.x,
    y: bounds.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // macOS: a plain window does not appear above fullscreen Spaces even with
    // visibleOnFullScreen; NSPanel (type: 'panel') is required. Verified over
    // a fullscreen Electron window, click-through and Esc both work.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  window.setAlwaysOnTop(true, 'screen-saver', 1)
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  popupReady = false
  const reveal = (): void => {
    popupReady = true
    if (!headless && store.get().pending.length > 0 && !window.isVisible()) {
      window.show()
      window.focus()
    }
  }
  window.once('ready-to-show', reveal)
  window.webContents.once('did-finish-load', reveal)
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.log('[popup] did-fail-load', code, description, url)
  })
  window.on('closed', () => {
    popupWindow = null
    popupReady = false
  })
  window.on('blur', () => {
    // A permission prompt must not disappear just because focus moved.
    if (store.get().pending.length > 0) window.setAlwaysOnTop(true, 'screen-saver')
  })
  void loadRenderer(window, 'popup')
  return window
}

function syncPopup(forceShow = true): void {
  const state = store.get()
  const hasPending = state.pending.length > 0 || state.expired !== null
  if (!hasPending) {
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide()
    return
  }
  if (!popupWindow || popupWindow.isDestroyed()) popupWindow = createPopupWindow()
  const bounds = popupBounds()
  popupWindow.setPosition(bounds.x, bounds.y)
  if (!headless && forceShow) {
    popupWindow.show()
    popupWindow.setAlwaysOnTop(true, 'screen-saver')
    popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    popupWindow.moveTop()
    popupWindow.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
    // Re-assert after the first frame: macOS sometimes parks a freshly
    // created panel on the Space that was active at creation time.
    setTimeout(() => {
      if (!popupWindow || popupWindow.isDestroyed()) return
      if (store.get().pending.length === 0) return
      popupWindow.show()
      popupWindow.moveTop()
      popupWindow.focus()
      if (process.platform === 'darwin') app.focus({ steal: true })
    }, 160)
  }
}

function logDecision(item: ApprovalItem, decision: string): void {
  const level: LogLevel =
    decision === 'allow' ? 'allow' : decision === 'deny' ? 'deny' : 'timeout'
  log(level, `${item.tool} · ${firstLine(item.detail) || item.message} · ${decisionLabel(decision)}`)
}

function respond(itemId: string, decision: string, extra?: ApprovalExtra): void {
  const item = store.get().pending.find((entry) => entry.id === itemId)
  const handledByServer = server.respond(itemId, decision, extra)
  if (handledByServer) return

  const resolve = localApprovals.get(itemId)
  if (resolve) {
    localApprovals.delete(itemId)
    resolve(decision)
  }
  if (item) {
    store.removePending(itemId)
    logDecision(item, decision)
    if (decision === 'timeout' && store.get().pending.length === 0) store.setExpired(item)
  }
  syncPopup()
}

function firstLine(value: string): string {
  return value.split('\n').map((line) => line.trim()).find(Boolean) || ''
}

function decisionLabel(decision: string): string {
  if (decision === 'allow') return '弹窗允许'
  if (decision === 'deny') return '弹窗拒绝'
  if (decision === 'timeout') return '超时交给终端'
  if (decision === 'cancelled') return '终端已处理'
  if (decision === 'suggestion') return '已应用权限建议'
  if (decision === 'answer') return '已从桌面回答'
  return '交给终端'
}

function createTray(): void {
  const iconName = process.platform === 'win32' ? 'app.ico' : 'trayTemplate.png'
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, iconName)
    : join(app.getAppPath(), 'resources', iconName)
  const icon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip(APP_NAME)
  tray.on('click', () => showMainWindow())
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '复制 Token',
      click: () => {
        clipboard.writeText(store.get().server.token)
        store.setToast('Token 已复制')
      }
    },
    {
      label: '复制配置命令',
      click: () => {
        const state = store.get()
        const address = `http://${state.server.localIp}:${state.server.port}`
        clipboard.writeText(
          `curl -X POST ${address}/claude-notify \\\n` +
            `  -H "Authorization: Bearer ${state.server.token}" \\\n` +
            `  -H "Content-Type: application/json" \\\n` +
            `  -d '{"message":"hello"}'`
        )
        store.setToast('配置命令已复制')
      }
    },
    {
      label: '测试通知',
      click: () => {
        void testNotify()
      }
    },
    {
      label: '测试审批弹窗',
      click: () => {
        void testApproval()
      }
    },
    ...(process.platform === 'darwin' || process.platform === 'win32'
      ? [
          { type: 'separator' as const },
          {
            label: '开机自启',
            type: 'checkbox' as const,
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item: Electron.MenuItem): void => {
              app.setLoginItemSettings({ openAtLogin: Boolean(item.checked) })
            }
          }
        ]
      : []),
    { type: 'separator' },
    { label: '退出', role: 'quit' }
  ])
  tray.setContextMenu(menu)
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    return
  }
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

async function toggleServer(): Promise<void> {
  if (server.isListening()) {
    await server.stop()
    store.setListening(false)
    log('warn', 'HTTP 服务已停止，审批请求将回退到终端')
    return
  }
  try {
    await server.start()
    store.setListening(true)
    log('info', `HTTP 服务已启动 · 0.0.0.0:${PORT}`)
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `端口 ${PORT} 已被占用`
      : String(error)
    log('error', `HTTP 服务启动失败：${message}`)
  }
}

async function testNotify(): Promise<void> {
  store.patch((draft) => {
    draft.server.notified += 1
  })
  log('notify', '测试通知 · 已将系统通知推送到通知中心')
  if (Notification.isSupported()) {
    new Notification({
      title: 'Claude Code',
      body: 'Claude 正在等待你的输入',
      silent: false
    }).show()
  }
}

function scheduleLocalTimeout(id: string, seconds: number): void {
  setTimeout(() => {
    if (store.get().pending.some((entry) => entry.id === id)) respond(id, 'timeout')
  }, seconds * 1000)
}

async function testApproval(): Promise<void> {
  const id = `local_${randomUUID()}`
  const item: ApprovalItem = {
    id,
    requestId: id,
    sessionId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'permission',
    tool: 'Bash',
    project: 'claude-code-notify',
    cwd: '~/workspace/claude-code-notify',
    message: 'Claude 请求执行权限',
    detail: 'git push origin feature/approval-popup --force-with-lease',
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ],
    suggestions: [],
    questions: [],
    createdAt: Date.now(),
    timeoutAt: Date.now() + 50 * 1000,
    timeoutSec: 50
  }
  const result = new Promise<string>((resolve) => {
    localApprovals.set(id, resolve)
  })
  store.addPending(item)
  scheduleLocalTimeout(id, item.timeoutSec)
  log('notify', `测试审批 · ${item.tool} · 等待桌面选择`)
  syncPopup()
  const decision = await result
  void decision
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function registerIpc(): void {
  ipcMain.handle('state:get', () => store.get())
  ipcMain.handle(
    'approval:respond',
    (_event, id: string, decision: string, extra?: ApprovalExtra) => {
      respond(id, decision, extra)
    }
  )
  ipcMain.handle('server:toggle', () => toggleServer())
  ipcMain.handle('test:notify', () => testNotify())
  ipcMain.handle('test:approval', () => testApproval())
  ipcMain.handle('clipboard:write', (_event, text: string) => {
    clipboard.writeText(text)
    store.setToast('已复制到剪贴板')
  })
  ipcMain.handle('token:regenerate', () => {
    const token = randomBytes(24).toString('hex')
    store.setToken(token)
    server.setToken(token)
    try {
      saveToken(token)
    } catch (error) {
      log('error', `Token 写入失败：${String(error)}`)
    }
    log('warn', 'Token 已重新生成，旧 Token 立即失效；请重新部署服务器钩子')
    store.setToast('Token 已更新，需重新部署')
    const hasRemote = Object.keys(loadDeployCache()).length > 0
    const local = detectLocalDeploy()
    if (hasRemote || local) {
      setTimeout(() => {
        const options = {
          type: 'warning' as const,
          buttons: ['知道了'],
          title: 'Token 已更新',
          message: '旧的部署已失效，需要重新部署',
          detail: local
            ? '本机接入和服务器钩子都会继续使用旧 Token；请重新执行「接入本机」或「部署并验证」。'
            : '服务器钩子会继续使用旧 Token；请重新执行「部署并验证」。'
        }
        if (mainWindow) void dialog.showMessageBox(mainWindow, options)
        else void dialog.showMessageBox(options)
      }, 200)
    }
  })
  ipcMain.handle('deploy:cache', (): DeployCacheView => {
    const cache = loadDeployCache()
    return { ...cache, password: decryptSecret(cache.passwordEncrypted) }
  })
  ipcMain.handle('security:info', (): SecurityInfo => ({
    available: secureStorageAvailable(),
    label: secureStorageLabel()
  }))
  ipcMain.handle('deploy:pick-key', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择私钥文件',
      properties: ['openFile'],
      defaultPath: join(homedir(), '.ssh')
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('deploy:test', async (_event, form: DeployFormConfig) => {
    const config = {
      ...form,
      token: store.get().server.token,
      approvalTimeout: Math.max(5, form.hookTimeout - 60)
    }
    return testSshConnection(config)
  })
  ipcMain.handle('local:status', () => {
    const mode = detectLocalDeploy()
    return { deployed: Boolean(mode), mode }
  })
  ipcMain.handle('local:deploy', async (_event, mode: 'popup' | 'notify') => {
    const options = {
      type: 'question' as const,
      buttons: ['接入本机', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '接入本机',
      message: '将钩子写入本机 Claude Code 配置？',
      detail:
        `目标：~/.claude/settings.json\n` +
        `模式：${mode === 'popup' ? '置顶弹窗' : '系统通知'}\n` +
        '会先备份现有 settings.json，并保留第三方 hooks。'
    }
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    if (confirmation.response !== 0) {
      return { ok: false, canceled: true, message: '已取消' }
    }
    try {
      const result = deployLocal(
        {
          mode,
          token: store.get().server.token,
          port: PORT,
          timeoutSec: 240,
          writeEnv: false,
          envShells: []
        },
        (level, message) => log(level, message)
      )
      store.patch((draft) => {
        draft.deploy = {
          status: 'deployed',
          host: '本机 · 127.0.0.1',
          hooks: mode === 'popup' ? 2 : 1,
          message: `本机已接入 · ${result.settingsPath}`
        }
      })
      store.setToast('本机接入完成')
      return { ok: true, message: '本机接入完成' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `本机接入失败：${message}`)
      store.setToast('本机接入失败，见日志')
      return { ok: false, message }
    }
  })
  ipcMain.handle('deploy:start', async (event, form: DeployFormConfig): Promise<DeployResult> => {
    const token = store.get().server.token
    const config = {
      ...form,
      token,
      approvalTimeout: Math.max(5, form.hookTimeout - 60)
    }

    const cache = {
      mode: form.mode,
      host: form.host,
      sshPort: form.sshPort,
      username: form.username,
      authMethod: form.authMethod,
      keyPath: form.keyPath,
      callbackIp: form.callbackIp,
      callbackPort: form.callbackPort,
      hookTimeout: form.hookTimeout,
      toolMatcher: form.toolMatcher,
      rememberPassword: form.rememberPassword,
      envImport: form.envImport,
      envShells: form.envShells
    }
    if (form.rememberPassword && form.password) {
      const encrypted = encryptSecret(form.password)
      if (encrypted) {
        ;(cache as Record<string, unknown>).passwordEncrypted = encrypted
      } else {
        cache.rememberPassword = false
      }
    }
    saveDeployCache(cache)

    store.patch((draft) => {
      draft.deploy = {
        status: 'running',
        host: `${form.username}@${form.host}:${form.sshPort}`,
        hooks: 0,
        message: '正在连接…'
      }
    })
    log('deploy', `开始部署 · ${form.username}@${form.host}:${form.sshPort}`)

    const progress = (level: LogLevel, message: string): void => {
      log(level, message)
      if (!event.sender.isDestroyed()) {
        event.sender.send('deploy:progress', { level, message })
      }
    }

    try {
      const result = await deployToServer(config, progress)
      store.patch((draft) => {
        draft.deploy = {
          status: 'deployed',
          host: `${form.username}@${form.host}:${form.sshPort}`,
          hooks: form.mode === 'popup' ? 2 : 1,
          message: result.connectivity
            ? `上次成功 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
            : '已写入，连通性未通过'
        }
      })
      if (result.connectivity) store.setToast('部署完成 · 钩子已生效')
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `部署失败：${message}`)
      store.patch((draft) => {
        draft.deploy = {
          status: 'error',
          host: `${form.username}@${form.host}:${form.sshPort}`,
          hooks: 0,
          message: '部署失败'
        }
      })
      return { success: false, summary: message, connectivity: false }
    }
  })
  ipcMain.handle('pref:position', (_event, position: PopupPosition) => {
    store.setPosition(position)
    saveUiConfig({ ...loadUiConfig(), position })
    if (store.get().pending.length > 0) syncPopup(false)
  })
  ipcMain.handle('pref:mode', (_event, mode: 'popup' | 'notify') => {
    store.setMode(mode)
    saveUiConfig({ ...loadUiConfig(), mode })
  })
  ipcMain.handle('logs:open', () => {
    if (logFile && existsSync(logFile)) shell.showItemInFolder(logFile)
  })
  ipcMain.handle('window:hide', () => mainWindow?.hide())
  ipcMain.on('popup:resize', (_event, height: number) => {
    if (!popupWindow || popupWindow.isDestroyed()) return
    const bounds = popupWindow.getBounds()
    const nextHeight = Math.max(260, Math.min(640, Math.round(height)))
    if (Math.abs(nextHeight - bounds.height) < 2) return
    popupWindow.setBounds({
      x: bounds.x,
      y: bounds.y + bounds.height - nextHeight,
      width: POPUP_WIDTH,
      height: nextHeight
    })
  })
  ipcMain.handle('app:quit', () => app.quit())
}

async function runSelfTest(): Promise<void> {
  const results: Record<string, unknown> = {}
  const base = `http://127.0.0.1:${PORT}`
  const token = store.get().server.token
  let latestApproval: ApprovalItem | null = null

  const health = await fetch(`${base}/health`)
  results.health = { status: health.status, body: await health.json() }

  const unauthorized = await fetch(`${base}/claude-approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  results.unauthorized = unauthorized.status

  const started = Date.now()
  const approvalPromise = fetch(`${base}/claude-approval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      request_id: 'req_selftest',
      tool_name: 'Bash',
      cwd: '/Users/hfwang/workspace/claude-code-notify',
      message: 'Claude 请求执行权限',
      tool_input: { command: 'git push --force-with-lease' },
      options: [
        { id: 'allow', label: '允许' },
        { id: 'deny', label: '拒绝' }
      ],
      timeout_seconds: 30
    })
  }).then(async (response) => ({
    status: response.status,
    body: await response.json(),
    elapsed: Date.now() - started
  }))

  await delay(600)
  latestApproval = store.get().pending[0] || null
  results.approvalShown = Boolean(latestApproval)
  results.pendingLabel = latestApproval ? `${latestApproval.tool}:${latestApproval.project}` : null
  if (latestApproval) respond(latestApproval.id, 'allow')
  const approval = await approvalPromise
  results.approval = approval
  results.approvalHeldOpen = approval.elapsed >= 500

  const waitPending = async (requestId: string): Promise<ApprovalItem | null> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const item = store.get().pending.find((entry) => entry.requestId === requestId)
      if (item) return item
      await delay(50)
    }
    return null
  }

  const postApproval = async (payload: Record<string, unknown>): Promise<{
    status: number
    body: Record<string, unknown>
  }> => {
    const response = await fetch(`${base}/claude-approval`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ timeout_seconds: 30, ...payload })
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  // question / answer
  const questionPayload = {
    request_id: 'req_question',
    kind: 'question',
    tool_name: 'AskUserQuestion',
    cwd: '/Users/hfwang/workspace/claude-code-notify',
    message: 'Claude 想问你一个问题',
    tool_input: {
      questions: [
        {
          question: '选择部署环境',
          options: [{ label: 'Staging' }, { label: 'Production' }]
        }
      ]
    },
    questions: [
      {
        question: '选择部署环境',
        multiSelect: false,
        options: [{ label: 'Staging' }, { label: 'Production' }]
      }
    ],
    options: [{ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' }]
  }
  const questionPromise = postApproval(questionPayload)
  const questionItem = await waitPending('req_question')
  results.questionShown = Boolean(questionItem)
  if (questionItem) {
    respond(questionItem.id, 'answer', {
      answers: [{ question: '选择部署环境', selected: ['Staging'], text: '' }]
    })
  }
  results.question = await questionPromise

  // suggestion / index
  const suggestionPromise = postApproval({
    request_id: 'req_suggestion',
    tool_name: 'Bash',
    cwd: '/Users/hfwang/workspace/claude-code-notify',
    message: 'Claude 请求执行权限',
    options: [{ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' }],
    suggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }]
      }
    ]
  })
  const suggestionItem = await waitPending('req_suggestion')
  results.suggestionShown = Boolean(suggestionItem)
  if (suggestionItem) respond(suggestionItem.id, 'suggestion', { index: 0 })
  results.suggestion = await suggestionPromise

  // terminal resolved
  const resolvedPromise = postApproval({
    request_id: 'req_resolved',
    tool_name: 'Edit',
    cwd: '/Users/hfwang/workspace/claude-code-notify',
    message: 'Claude 请求修改文件',
    timeout_seconds: 120
  })
  await waitPending('req_resolved')
  const resolveResponse = await fetch(`${base}/claude-approval-resolved`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ request_id: 'req_resolved' })
  })
  results.resolved = { status: resolveResponse.status, body: await resolveResponse.json() }
  results.resolvedApproval = await resolvedPromise

  const unknownResolved = await fetch(`${base}/claude-approval-resolved`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ request_id: 'req_missing' })
  })
  results.unknownResolved = unknownResolved.status

  const timeoutStarted = Date.now()
  const timeoutResponse = await postApproval({
    request_id: 'req_timeout',
    tool_name: 'Bash',
    cwd: '/Users/hfwang/workspace/claude-code-notify',
    message: 'timeout test',
    timeout_seconds: 5
  })
  await delay(200)
  results.timeout = {
    status: timeoutResponse.status,
    body: timeoutResponse.body,
    elapsed: Date.now() - timeoutStarted
  }
  results.expiredShown = Boolean(store.get().expired)
  store.setExpired(null)

  console.log(`SELFTEST_RESULT ${JSON.stringify(results)}`)
  await server.stop()
  app.exit(0)
}

async function runDeploySelfTest(): Promise<void> {
  const authMethod = process.env.DEPLOY_AUTH === 'key' ? 'key' : 'password'
  const config = {
    mode: (process.env.DEPLOY_MODE === 'notify' ? 'notify' : 'popup') as 'popup' | 'notify',
    host: process.env.DEPLOY_HOST || '127.0.0.1',
    sshPort: Number(process.env.DEPLOY_SSH_PORT || 2222),
    username: process.env.DEPLOY_USER || 'deploy',
    authMethod: authMethod as 'password' | 'key',
    password: authMethod === 'password' ? process.env.DEPLOY_PASSWORD || 'deploy' : undefined,
    keyPath: authMethod === 'key' ? process.env.DEPLOY_KEY_PATH : undefined,
    keyPassphrase: authMethod === 'key' ? process.env.DEPLOY_KEY_PASSPHRASE : undefined,
    callbackIp: process.env.DEPLOY_CALLBACK_IP || 'host.docker.internal',
    callbackPort: Number(process.env.DEPLOY_CALLBACK_PORT || PORT),
    hookTimeout: 300,
    approvalTimeout: 240,
    toolMatcher: '',
    envShells: ['bash'],
    token: store.get().server.token
  }
  try {
    const result = await deployToServer(config, (level, message) => {
      console.log(`[deploy:${level}] ${message}`)
    })
    console.log(`DEPLOY_SELFTEST_RESULT ${JSON.stringify(result)}`)
    await server.stop()
    app.exit(result.success ? 0 : 1)
  } catch (error) {
    console.log(
      `DEPLOY_SELFTEST_RESULT ${JSON.stringify({
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        connectivity: false
      })}`
    )
    await server.stop()
    app.exit(1)
  }
}

function handleApproval(item: ApprovalItem): void {
  store.setExpired(null)
  store.addPending(item)
  syncPopup()
}

async function runCapture(): Promise<void> {
  store.patch((draft) => {
    draft.server.notified = 18
    draft.deploy = {
      status: 'deployed',
      host: 'deploy@192.168.1.20:22',
      hooks: 2,
      message: '上次成功 16:15'
    }
  })
  log('deploy', 'settings.json 合并完成 · 旧 PreToolUse 残留已清理')
  log('notify', '通知 · 会话 7f3a · 等待输入 · 已推送系统通知')
  log('allow', 'Bash · git status · 弹窗允许 · 2.6s')

  await delay(1200)
  if (!mainWindow) throw new Error('main window missing')
  const mainImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'main.png'), mainImage.toPNG())

  const id = 'apr_capture'
  store.addPending({
    id,
    requestId: 'req_capture',
    sessionId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'permission',
    cwd: '',
    tool: 'Bash',
    project: 'claude-code-notify',
    message: 'Claude 请求执行权限',
    detail: 'git push origin feature/approval-popup --force-with-lease',
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ],
    suggestions: [],
    questions: [],
    createdAt: Date.now(),
    timeoutAt: Date.now() + 39000,
    timeoutSec: 60
  })
  store.addPending({
    id: 'apr_capture_2',
    requestId: 'req_capture_2',
    sessionId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'permission',
    cwd: '',
    tool: 'Edit',
    project: 'claude-code-notify',
    message: 'Claude 请求修改文件',
    detail: 'src/renderer/src/App.tsx',
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ],
    suggestions: [],
    questions: [],
    createdAt: Date.now(),
    timeoutAt: Date.now() + 240000,
    timeoutSec: 240
  })
  syncPopup(false)
  if (!popupWindow) throw new Error('popup window missing')
  await delay(1200)
  const popupImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup.png'), popupImage.toPNG())

  store.removePending('apr_capture')
  store.removePending('apr_capture_2')
  store.addPending({
    id: 'apr_question',
    requestId: 'req_question',
    sessionId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'question',
    tool: 'AskUserQuestion',
    project: 'claude-code-notify',
    cwd: '',
    message: 'Claude 想问你一个问题',
    detail: '选择部署环境',
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ],
    suggestions: [],
    questions: [
      {
        question: '这次要部署到哪个环境？',
        multiSelect: false,
        options: [
          { label: 'Staging', description: '预发布环境，可随时回滚' },
          { label: 'Production', description: '生产环境，需要二次确认' }
        ]
      }
    ],
    createdAt: Date.now(),
    timeoutAt: Date.now() + 39000,
    timeoutSec: 60
  })
  syncPopup(false)
  await delay(1200)
  const questionImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup-question.png'), questionImage.toPNG())

  store.removePending('apr_question')
  store.setExpired({
    id: 'apr_expired',
    requestId: 'req_expired',
    sessionId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'permission',
    tool: 'Bash',
    project: 'claude-code-notify',
    cwd: '',
    message: 'Claude 请求执行权限',
    detail: 'git push origin feature/approval-popup --force-with-lease',
    options: [],
    suggestions: [],
    questions: [],
    createdAt: Date.now() - 60000,
    timeoutAt: Date.now() - 1000,
    timeoutSec: 60
  })
  syncPopup(false)
  await delay(1000)
  const expiredImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup-expired.png'), expiredImage.toPNG())

  console.log('CAPTURE_DONE')
  app.exit(0)
}

app.whenReady().then(async () => {
  const token = loadOrCreateToken()
  logFile = join(appDataDir(), 'claude-notify.log')
  store = new Store({
    token,
    port: PORT,
    localIp: localIp(),
    version: app.getVersion(),
    platform: process.platform
  })
  store.subscribe(broadcast)
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(join(app.getAppPath(), 'build', 'icon.png'))
  }
  const uiConfig = loadUiConfig()
  const savedPosition = uiConfig.position || uiConfig.popup_screen
  if (savedPosition) store.setPosition(savedPosition)
  if (uiConfig.mode) store.setMode(uiConfig.mode)
  if (typeof uiConfig.timeoutSec === 'number') {
    store.patch((draft) => {
      draft.prefs.timeoutSec = uiConfig.timeoutSec as number
    })
  }

  server = new NotifyServer(PORT, token, {
    onApproval: (item) => {
      log('notify', `收到审批 · ${item.tool} · ${item.project}`)
      handleApproval(item)
    },
    onResolved: (itemId, decision) => {
      const item = store.get().pending.find((entry) => entry.id === itemId)
      if (item) {
        store.removePending(itemId)
        logDecision(item, decision)
        if (decision === 'timeout' && store.get().pending.length === 0) store.setExpired(item)
        syncPopup()
      }
    },
    onNotify: (title, body) => {
      store.patch((draft) => {
        draft.server.notified += 1
      })
      log('notify', `通知 · ${title}`)
      if (Notification.isSupported()) {
        new Notification({ title, body, silent: false }).show()
      }
    },
    onLog: (level, message) => log(level, message)
  })

  try {
    await server.start()
    store.setListening(true)
    log('info', `HTTP 服务已启动 · 0.0.0.0:${PORT} · Bearer Token 校验开启`)
  } catch (error) {
    log('error', `HTTP 服务启动失败：${String(error)}`)
  }

  registerIpc()
  mainWindow = createMainWindow()

  if (isSelfTest) {
    await runSelfTest()
    return
  }
  if (isCapture) {
    await runCapture()
    return
  }
  if (isDeployTest) {
    await runDeploySelfTest()
    return
  }

  createTray()
  if (!headless) showMainWindow()

  if (isDemo) {
    await delay(900)
    const item: ApprovalItem = {
      id: 'local_demo',
      requestId: 'req_demo',
      sessionId: '',
      toolUseId: '',
      transcriptPath: '',
      kind: 'permission',
      cwd: '',
      tool: 'Bash',
      project: 'claude-code-notify',
      message: 'Claude 请求执行权限',
      detail: 'git push origin feature/approval-popup --force-with-lease',
      options: [
        { id: 'allow', label: '允许' },
        { id: 'deny', label: '拒绝' }
      ],
      suggestions: [],
      questions: [],
      createdAt: Date.now(),
      timeoutAt: Date.now() + 39000,
      timeoutSec: 60
    }
    localApprovals.set(item.id, () => undefined)
    store.addPending(item)
    scheduleLocalTimeout(item.id, item.timeoutSec)
    syncPopup()
    if (process.argv.includes('--fullscreen-demo')) {
      setTimeout(() => mainWindow?.setFullScreen(true), 1800)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep running in the tray on every platform; quit is explicit.
})

app.on('before-quit', () => {
  void server?.stop()
})
