import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  Tray
} from 'electron'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import type {
  AppState,
  ApprovalExtra,
  ApprovalItem,
  ApprovalRecord,
  ApprovalRule,
  BindMode,
  CompletionNotice,
  DecisionSource,
  DeployFormConfig,
  DeployProfile,
  DeployResult,
  DeployTestResult,
  LogLevel,
  PopupPosition,
  Prefs,
  RuleScope,
  SecurityInfo
} from '../shared/types'
import {
  approvalCommand,
  assessRisk,
  projectName,
  riskLabel,
  sortByDeadline
} from '../shared/session'
import { buildRuleFromItem, matchingRule, validateRule } from '../shared/rules'
import {
  canDeliverSystemNotification,
  isWithinQuietHours,
  shouldShowCompletionPopup
} from '../shared/notification-policy'
import { computeDeployDrift } from '../shared/deploy-drift'
import {
  anchorFromLegacyPosition,
  resolvePopupBounds,
  type PopupAnchor
} from '../shared/popup-layout'
import {
  appDataDir,
  decryptSecret,
  encryptSecret,
  ensureDataDir,
  loadDeployCache,
  loadDeployProfiles,
  loadKnownHosts,
  loadOrCreateToken,
  loadRules,
  loadUiConfig,
  readJsonFile,
  writeJsonFile,
  saveDeployCache,
  saveDeployProfiles,
  saveKnownHosts,
  saveRules,
  saveToken,
  saveUiConfig,
  secureStorageAvailable,
  secureStorageLabel,
  type KnownHostMap,
  type UiConfig
} from './config'
import {
  deployLocal,
  detectLocalState,
  removeLocalDeploy,
  restoreLocalBackup
} from './deploy/local'
import { HOOK_VERSION } from './deploy/settings'
import {
  deployToServer,
  humanizeSshError,
  isDeployCancelled,
  removeDeployFromServer,
  restoreDeployBackup,
  testSshConnection
} from './deploy/ssh'
import { HistoryStore } from './history'
import { isPortFree, listAddresses, preferredAddress } from './net'
import { approvalFromPayload, safeString } from './protocol'
import { NotifyServer } from './server'
import { SessionRegistry } from './sessions'
import { Store } from './store'
import {
  canUseNativeUpdater,
  checkForAppUpdate,
  downloadAppUpdate,
  initAutoUpdater,
  installAppUpdate
} from './auto-update'

const APP_NAME = 'Claude Notify'
const DEFAULT_PORT = 18765
const POPUP_WIDTH = 560
const POPUP_HEIGHT = 540
const LOG_MAX_BYTES = 5 * 1024 * 1024
const BROADCAST_INTERVAL_MS = 16
const MAIN_QUEUE_FLUSH_DELAY_MS = 30
const MAIN_QUEUE_MAX = 200

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
let popupAnchor: PopupAnchor | null = null
let suppressMoveSave = false
let serverPort = DEFAULT_PORT
let serverBindMode: BindMode = 'all'
let currentTheme: 'dark' | 'light' = 'dark'
let logFile = ''
let pendingSnapshotPath = ''
let logWrites = 0
let lastBadgeCount = -1
let lastBeepAt = 0
let lastTraySignature = ''
let trayRefreshTimer: NodeJS.Timeout | null = null
let notificationQueue: ApprovalItem[] = []
let notificationTimer: NodeJS.Timeout | null = null
let noticeTimer: NodeJS.Timeout | null = null

const localApprovals = new Map<string, (decision: string) => void>()
const localTimers = new Map<string, NodeJS.Timeout>()
const snoozeTimers = new Map<string, NodeJS.Timeout>()
const decisionSources = new Map<string, DecisionSource>()
const decisionRules = new Map<string, string>()
const decisionReasons = new Map<string, string>()
const itemCache = new Map<string, ApprovalItem>()
const settledIds = new Set<string>()

let mainWindowReady = false
let mainQueueTimer: NodeJS.Timeout | null = null
const mainQueue: Array<{ channel: string; args: unknown[] }> = []

let broadcastTimer: NodeJS.Timeout | null = null
let pendingBroadcast: AppState | null = null

let quitting = false
let quitAllowed = false

let sessions: SessionRegistry
let history: HistoryStore
let rules: ApprovalRule[] = []
let profiles: DeployProfile[] = []
let knownHosts: KnownHostMap = {}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function rotateLogIfNeeded(force = false): void {
  if (!logFile) return
  try {
    if (!existsSync(logFile)) return
    if (!force && statSync(logFile).size <= LOG_MAX_BYTES) return
    const previous = `${logFile}.1`
    if (existsSync(previous)) unlinkSync(previous)
    renameSync(logFile, previous)
  } catch {
    // rotation is best-effort
  }
}

function log(level: LogLevel, message: string): void {
  store.log(level, message)
  try {
    if (!logFile) return
    logWrites += 1
    if (logWrites % 50 === 0) rotateLogIfNeeded()
    appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
  } catch {
    // logging must never break the app
  }
}

function persistPendingSnapshot(): void {
  if (!pendingSnapshotPath || !store) return
  try {
    writeJsonFile(
      pendingSnapshotPath,
      store.get().pending.map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        sessionKey: item.sessionKey,
        sessionLabel: item.sessionLabel,
        origin: item.origin,
        tool: item.tool,
        project: item.project,
        task: item.task,
        createdAt: item.createdAt
      }))
    )
  } catch {
    // snapshot is best-effort
  }
}

function flushBroadcast(): void {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
  const state = pendingBroadcast
  pendingBroadcast = null
  if (!state) return
  for (const window of [mainWindow, popupWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('state:update', state)
  }
  // Keep the non-state side effects tied to the final coalesced update.
  updateBadge()
  scheduleTrayRefresh()
}

function broadcast(state: AppState): void {
  pendingBroadcast = state
  if (broadcastTimer) return
  broadcastTimer = setTimeout(flushBroadcast, BROADCAST_INTERVAL_MS)
}

function sendToMainNow(channel: string, ...args: unknown[]): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  try {
    mainWindow.webContents.send(channel, ...args)
    return true
  } catch {
    return false
  }
}

function flushMainQueue(): void {
  mainQueueTimer = null
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) return
  const queued = mainQueue.splice(0, mainQueue.length)
  for (let index = 0; index < queued.length; index += 1) {
    const message = queued[index]
    if (!sendToMainNow(message.channel, ...message.args)) {
      // Window went away mid-flush; preserve the rest for the next window.
      mainQueue.unshift(...queued.slice(index))
      return
    }
  }
}

function scheduleMainQueueFlush(): void {
  if (mainQueueTimer) return
  mainQueueTimer = setTimeout(flushMainQueue, MAIN_QUEUE_FLUSH_DELAY_MS)
}

function sendToMain(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Keep strict ordering: while anything is queued, later messages queue too.
  if (mainWindowReady && mainQueue.length === 0) {
    sendToMainNow(channel, ...args)
    return
  }
  mainQueue.push({ channel, args })
  if (mainQueue.length > MAIN_QUEUE_MAX) mainQueue.splice(0, mainQueue.length - MAIN_QUEUE_MAX)
  if (mainWindowReady) scheduleMainQueueFlush()
}

function sendUiCommand(command: 'prefs' | 'about' | 'inbox' | 'status' | 'deploy'): void {
  showMainWindow()
  sendToMain('ui:command', command)
}

function focusSession(key: string): void {
  showMainWindow()
  sendToMain('focus:session', key)
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function loadRenderer(window: BrowserWindow, hash: string): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return window.loadURL(`${devUrl}#${hash}`)
  return window.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

/**
 * Renderer pages may only navigate within the Vite dev server (when present)
 * or to a bundled file:// page. Anything else is blocked; external links are
 * still opened by `setWindowOpenHandler` via `shell.openExternal`.
 */
function isAllowedRendererNavigation(url: string): boolean {
  try {
    const target = new URL(url)
    if (target.protocol === 'file:') return true
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (!devUrl) return false
    return target.origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

/**
 * Apply the navigation and webview guards shared by every app window.
 * `<webview>` is never part of this UI, so attaching one is always denied.
 */
function hardenWebContents(contents: Electron.WebContents): void {
  contents.on('will-navigate', (event) => {
    if (isAllowedRendererNavigation(event.url)) return
    event.preventDefault()
    log('warn', `已阻止渲染进程导航 · ${event.url}`)
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/**
 * Deny every renderer permission request (camera, microphone, geolocation,
 * notifications, ...). Main-process `Notification` delivery is unaffected
 * because it does not go through the renderer session permission handler.
 */
function installPermissionRequestGuard(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )
}

function windowsBuild(): number {
  if (process.platform !== 'win32') return 0
  return Number(release().split('.')[2] || 0)
}

function resolveTheme(): 'dark' | 'light' {
  const theme = store?.get().prefs.theme || 'system'
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return theme
}

function windowsAcrylicEnabled(): boolean {
  return (
    process.platform === 'win32' &&
    process.env.CLAUDE_NOTIFY_OPAQUE !== '1' &&
    windowsBuild() >= 22621
  )
}

function applyWindowTheme(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    if (process.platform === 'darwin') {
      mainWindow.setVibrancy(currentTheme === 'dark' ? 'hud' : null)
    }
    mainWindow.setBackgroundColor(
      windowsAcrylicEnabled()
        ? '#00000000'
        : currentTheme === 'dark'
          ? '#0a0a0c'
          : '#f3f2ee'
    )
  } catch {
    // material changes are best-effort
  }
}

function createMainWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(1080, area.width - 40)
  const height = Math.min(820, area.height - 40)
  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'
  const forceOpaque = process.env.CLAUDE_NOTIFY_OPAQUE === '1'
  const useAcrylic = windowsAcrylicEnabled()
  const useMacGlass = isMac && !forceOpaque && currentTheme === 'dark'
  const useGlass = useMacGlass || useAcrylic
  const window = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: useGlass ? '#00000000' : currentTheme === 'dark' ? '#0a0a0c' : '#f3f2ee',
    transparent: useGlass,
    vibrancy: useMacGlass ? 'hud' : undefined,
    visualEffectState: useMacGlass ? 'active' : undefined,
    backgroundMaterial: useAcrylic ? 'acrylic' : undefined,
    roundedCorners: true,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 21 } : undefined,
    titleBarOverlay: isWindows
      ? { color: '#00000000', symbolColor: '#d4d4d8', height: 58 }
      : undefined,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => {
    if (!headless) window.show()
  })
  mainWindowReady = false
  window.webContents.on('did-finish-load', () => {
    if (window !== mainWindow) return
    // Give the renderer one tick to attach its listeners before replaying
    // commands that arrived while the window was being created/reloaded.
    mainWindowReady = true
    scheduleMainQueueFlush()
  })
  window.on('closed', () => {
    mainWindow = null
    mainWindowReady = false
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  hardenWebContents(window.webContents)
  void loadRenderer(window, 'main')
  return window
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    return
  }
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
  sendToMain('state:update', store.get())
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

function popupBounds(height = POPUP_HEIGHT): { x: number; y: number } {
  const display = popupAnchor
    ? screen.getDisplayNearestPoint({ x: popupAnchor.x, y: popupAnchor.bottom })
    : popupDisplay()
  return resolvePopupBounds({
    width: POPUP_WIDTH,
    height,
    area: display.workArea,
    anchor: popupAnchor
  })
}

let popupResizeTimer: NodeJS.Timeout | null = null

function savePopupPosition(): void {
  if (!popupWindow || popupWindow.isDestroyed() || suppressMoveSave) return
  const bounds = popupWindow.getBounds()
  // Persist the bottom edge, not the top-left corner. A top-left saved from a
  // taller window makes the next 540px popup appear too high on Windows.
  popupAnchor = { x: bounds.x, bottom: bounds.y + bounds.height }
  if (popupResizeTimer) clearTimeout(popupResizeTimer)
  popupResizeTimer = setTimeout(() => {
    saveUiConfig({
      popupAnchor,
      popupHeight: bounds.height,
      popupPosition: null
    })
  }, 250)
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
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
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
    if (headless) return
    if (store.get().pending.length > 0 || store.get().expired.length > 0) {
      window.showInactive()
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
    if (store.get().pending.length > 0) window.setAlwaysOnTop(true, 'screen-saver')
  })
  window.on('moved', savePopupPosition)
  hardenWebContents(window.webContents)
  void loadRenderer(window, 'popup')
  return window
}

function syncPopup(focusMode: 'none' | 'new' | 'manual' = 'none'): void {
  const state = store.get()
  const now = Date.now()
  const visiblePending = state.pending.filter(
    (item) => !item.snoozedUntil || item.snoozedUntil <= now
  )
  const hasApproval = visiblePending.length > 0 || state.expired.length > 0
  const hasNotice = Boolean(state.notice)
  if (!hasApproval && !hasNotice) {
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide()
    return
  }
  if (!popupWindow || popupWindow.isDestroyed()) {
    if (headless && !isCapture) return
    popupWindow = createPopupWindow()
  }
  if (headless) return

  suppressMoveSave = true
  const current = popupWindow.getBounds()
  const bounds = popupBounds(current.height)
  if (current.x !== bounds.x || current.y !== bounds.y) {
    popupWindow.setPosition(bounds.x, bounds.y)
  }
  setTimeout(() => {
    suppressMoveSave = false
  }, 120)

  popupWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const wasVisible = popupWindow.isVisible()
  const muted = visiblePending[0]
    ? sessions.isMuted(visiblePending[0].sessionKey)
    : false
  const policy = state.prefs.focusPolicy
  let shouldFocus =
    hasApproval &&
    (focusMode === 'manual'
      ? true
      : policy === 'always'
        ? true
        : policy === 'first'
          ? !wasVisible
          : false)
  if (muted && focusMode !== 'manual') shouldFocus = false

  if (shouldFocus) {
    popupWindow.show()
    popupWindow.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  } else {
    popupWindow.showInactive()
  }
  popupWindow.moveTop()
  if (shouldFocus) {
    setTimeout(() => {
      if (!popupWindow || popupWindow.isDestroyed()) return
      if (store.get().pending.length === 0 && store.get().expired.length === 0) return
      popupWindow.moveTop()
    }, 160)
  }
}

// ---------------------------------------------------------------------------
// badge, tray, menu
// ---------------------------------------------------------------------------

function updateBadge(): void {
  if (!store) return
  const count = store.get().pending.length
  const waitingSessions = new Set(store.get().pending.map((item) => item.sessionKey)).size
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '')
  }
  if (tray) {
    const waitingTitles = [
      ...new Set(store.get().pending.map((item) => sessionTitleFor(item)))
    ].slice(0, 3)
    tray.setToolTip(
      count > 0
        ? `${APP_NAME} · ${count} 条待审批 · ${waitingSessions} 个会话\n${waitingTitles.join('、')}`
        : `${APP_NAME} · 暂无待审批`
    )
    if (process.platform === 'darwin') {
      tray.setTitle(count > 0 ? String(count) : '')
    }
  }
  if (count !== lastBadgeCount) {
    lastBadgeCount = count
    refreshTrayMenu(true)
  }
}

function copyConnectCommand(): void {
  const state = store.get()
  const host = state.network.bindMode === 'loopback' ? '127.0.0.1' : state.server.localIp
  const address = `http://${host}:${state.server.port}`
  clipboard.writeText(
    `curl -X POST ${address}/claude-notify \\\n` +
      `  -H "Authorization: Bearer ${state.server.token}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"message":"hello"}'`
  )
  store.setToast('接入命令已复制')
}

function buildTrayMenu(): Menu {
  const state = store.get()
  const pending = state.pending.length
  const waitingSessions = new Set(state.pending.map((item) => item.sessionKey)).size
  const groups = new Map<string, ApprovalItem[]>()
  for (const item of state.pending) {
    const group = groups.get(item.sessionKey)
    if (group) group.push(item)
    else groups.set(item.sessionKey, [item])
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label:
        pending > 0
          ? `${pending} 条待审批 · ${waitingSessions} 个会话`
          : '暂无待审批',
      enabled: false
    }
  ]
  if (groups.size > 0) {
    template.push({
      label: '等待中的会话',
      submenu: [...groups.entries()].slice(0, 8).map(([key, items]) => {
        const info = state.sessions.find((session) => session.key === key)
        const title = info?.title || items[0].sessionLabel
        const task = info?.task || items[0].task
        return {
          label: `${items.length} · ${title}${task ? ` — ${task.slice(0, 34)}` : ''}`,
          click: () => focusSession(key)
        }
      })
    })
  }
  template.push(
    { label: '打开待审批', click: () => sendUiCommand('inbox') },
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '状态…', click: () => sendUiCommand('status') },
    { label: '部署…', click: () => sendUiCommand('deploy') },
    { type: 'separator' },
    {
      label: state.server.listening ? '暂停服务' : '启动服务',
      click: () => void toggleServer()
    },
    {
      label: '复制 Token',
      click: () => {
        clipboard.writeText(store.get().server.token)
        store.setToast('Token 已复制')
      }
    },
    { label: '复制接入命令', click: copyConnectCommand },
    { type: 'separator' },
    { label: '测试通知', click: () => void testNotify() },
    { label: '测试审批弹窗', click: () => void testApproval() },
    { label: '设置…', click: () => sendUiCommand('prefs') },
    { label: '关于', click: () => showAbout() },
    { type: 'separator' }
  )
  if (process.platform === 'darwin' || process.platform === 'win32') {
    template.push({
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item: Electron.MenuItem): void => {
        app.setLoginItemSettings({ openAtLogin: Boolean(item.checked) })
        store.setToast(item.checked ? '已开启开机自启' : '已关闭开机自启')
      }
    })
  }
  template.push({ type: 'separator' }, { label: '退出', role: 'quit' })
  return Menu.buildFromTemplate(template)
}

function refreshTrayMenu(force = false): void {
  if (!tray) return
  const state = store.get()
  const signature = [
    state.pending.length,
    state.server.listening,
    state.prefs.mode,
    state.deploy.localMode,
    state.deploy.profiles.length,
    state.sessions
      .filter((session) => session.waiting > 0)
      .map((session) => `${session.key}:${session.title}:${session.task}`)
      .join(',')
  ].join('|')
  if (!force && signature === lastTraySignature) return
  lastTraySignature = signature
  tray.setContextMenu(buildTrayMenu())
}

function scheduleTrayRefresh(): void {
  if (trayRefreshTimer) return
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null
    refreshTrayMenu()
  }, 200)
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
  refreshTrayMenu(true)
}

function showAbout(): void {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    copyright: 'Claude Code Notify'
  })
  if (process.platform === 'darwin') {
    app.showAboutPanel()
    return
  }
  void dialog.showMessageBox({
    type: 'info',
    title: `关于 ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail:
      '远程 Claude Code 审批中转。\n\n' +
      `HTTP 端口：${store.get().server.port}\n` +
      `钩子版本：${HOOK_VERSION}\n` +
      `本机地址：${store.get().server.localIp}`,
    buttons: ['好']
  })
}

function createAppMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendUiCommand('prefs')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// sessions & history
// ---------------------------------------------------------------------------

function refreshSessions(): void {
  if (!store) return
  const next = sessions.list(store.get().pending, store.get().history)
  store.setSessions(next)
  pruneExpiredRules()
}

/** Drop expired time-boxed rules and session rules whose session is gone. */
function pruneExpiredRules(): void {
  if (!store) return
  const now = Date.now()
  // Include metadata for sessions beyond the 16-item visible window so their
  // session rules are not deleted just because the list is capped.
  const meta = sessions.getMeta()
  const live = new Set([
    ...store.get().sessions.map((session) => session.key),
    ...Object.keys(meta)
  ])
  const next = rules.filter((rule) => {
    if (typeof rule.expiresAt === 'number' && rule.expiresAt <= now) return false
    if (rule.scope === 'session' && rule.sessionKey) {
      if (!live.has(rule.sessionKey)) return false
      const endedAt = meta[rule.sessionKey]?.endedAt
      if (endedAt && now - endedAt > 30 * 60 * 1000) return false
    }
    return true
  })
  if (next.length === rules.length) return
  const removed = rules.length - next.length
  rules = next
  saveRules(rules)
  store.setRules(rules)
  log('info', `已清理 ${removed} 条过期/失效规则`)
}

function computeModeMismatch(): boolean {
  const state = store.get()
  return Boolean(state.deploy.localMode && state.deploy.localMode !== state.prefs.mode)
}

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/**
 * Recompute the deployment drift list (and the legacy mode mismatch flag) from
 * the current store. Only call after bootstrap has created the Store.
 */
function refreshDeployHealth(): void {
  if (!store) return
  const state = store.get()
  store.setDeploy({
    drift: computeDeployDrift({
      localMode: state.deploy.localMode,
      prefsMode: state.prefs.mode,
      profiles: state.deploy.profiles,
      hookVersion: HOOK_VERSION,
      localIp: state.prefs.localIp,
      port: state.server.port,
      tokenFingerprint: fingerprintToken(state.server.token)
    }),
    modeMismatch: computeModeMismatch()
  })
}

function decisionLabel(decision: string): string {
  if (decision === 'allow') return '允许'
  if (decision === 'deny') return '拒绝'
  if (decision === 'timeout') return '超时回退终端'
  if (decision === 'cancelled') return '终端已处理'
  if (decision === 'suggestion') return '应用权限建议'
  if (decision === 'answer') return '桌面代答'
  if (decision === 'ask') return '回退终端'
  return decision
}

function decisionLevel(decision: string, source: DecisionSource): LogLevel {
  if (source === 'rule') return 'rule'
  if (decision === 'allow') return 'allow'
  if (decision === 'deny') return 'deny'
  if (decision === 'timeout') return 'timeout'
  if (decision === 'cancelled') return 'cancelled'
  if (decision === 'suggestion') return 'suggestion'
  if (decision === 'answer') return 'answer'
  if (decision === 'ask') return 'ask'
  return 'info'
}

function finishItem(item: ApprovalItem, decision: string, source: DecisionSource): void {
  // Always drop per-item bookkeeping, even for ids that were already settled.
  const ruleId = decisionRules.get(item.id)
  const reason = decisionReasons.get(item.id)
  decisionSources.delete(item.id)
  decisionRules.delete(item.id)
  decisionReasons.delete(item.id)
  itemCache.delete(item.id)
  clearLocalTimeout(item.id)
  clearSnoozeTimer(item.id)
  if (settledIds.has(item.id)) return
  settledIds.add(item.id)
  if (settledIds.size > 1000) settledIds.clear()

  const preview = (approvalCommand(item) || item.message).replace(/\s+/g, ' ').slice(0, 120)
  const sourceSuffix =
    source === 'rule'
      ? ' · 规则命中'
      : source === 'admission'
        ? ' · 队列准入回退'
        : source === 'server-stop'
          ? ' · 服务停止'
          : ''
  log(
    decisionLevel(decision, source),
    `${item.sessionLabel} · ${item.origin} · ${item.tool} · ${preview} · ${decisionLabel(decision)}${sourceSuffix}`
  )
  if (decision === 'timeout') {
    store.addExpired(item)
    notifyTimeout(item)
  } else if (decision === 'cancelled') {
    log('cancelled', `${item.sessionLabel} · 终端侧已处理，弹窗同步关闭`)
  }
  const record: ApprovalRecord = {
    id: randomUUID(),
    ts: Date.now(),
    sessionKey: item.sessionKey,
    sessionLabel: item.sessionLabel,
    origin: item.origin,
    project: item.project,
    tool: item.tool,
    message: item.message.slice(0, 300),
    command: (approvalCommand(item) || '').slice(0, 500),
    decision,
    source,
    latencyMs: Math.max(0, Date.now() - item.createdAt),
    risk: item.risk.level,
    ...(ruleId ? { ruleId } : {}),
    ...(reason ? { reason } : {})
  }
  history.append(record)
  store.addHistory(record)
  persistPendingSnapshot()
  refreshSessions()
  updateBadge()
  syncPopup('none')
}

function handleResolved(itemId: string, decision: string): void {
  const item =
    store.get().pending.find((entry) => entry.id === itemId) || itemCache.get(itemId) || null
  const source =
    decisionSources.get(itemId) ||
    (decision === 'timeout'
      ? 'timeout'
      : decision === 'cancelled'
        ? 'terminal'
        : 'popup')
  decisionSources.delete(itemId)
  itemCache.delete(itemId)
  if (!item) return
  store.removePending(itemId)
  finishItem(item, decision, source)
}

function respond(
  itemId: string,
  decision: string,
  extra?: ApprovalExtra,
  source: DecisionSource = 'popup'
): void {
  const item =
    store.get().pending.find((entry) => entry.id === itemId) || itemCache.get(itemId) || null
  if (item) {
    itemCache.set(item.id, item)
    decisionSources.set(item.id, source)
    if (extra?.reason?.trim()) decisionReasons.set(item.id, extra.reason.trim().slice(0, 2000))
  }
  const handledByServer = server.respond(itemId, decision, extra)
  if (handledByServer) return
  const resolve = localApprovals.get(itemId)
  if (resolve) {
    localApprovals.delete(itemId)
    resolve(decision)
  }
  if (item) {
    store.removePending(itemId)
    finishItem(item, decision, source)
  }
  syncPopup()
}

/** Apply one decision to every request in an identical-request cluster. */
function respondMany(
  itemIds: string[],
  decision: string,
  extra?: ApprovalExtra,
  source: DecisionSource = 'popup'
): void {
  const unique = [...new Set(itemIds.filter(Boolean))]
  for (const itemId of unique) {
    respond(itemId, decision, extra, source)
  }
}

function clearSnoozeTimer(itemId: string): void {
  const timer = snoozeTimers.get(itemId)
  if (!timer) return
  clearTimeout(timer)
  snoozeTimers.delete(itemId)
}

/**
 * Hide an approval for a while without changing its deadline. The hook keeps
 * waiting and the countdown keeps running; when the timer fires the popup is
 * shown again and a fresh notification is delivered.
 */
function snoozeApproval(itemId: string, minutes: number): void {
  const item = store.get().pending.find((entry) => entry.id === itemId)
  if (!item) return
  const clamped = Math.max(1, Math.min(60, Math.round(minutes)))
  const until = Date.now() + clamped * 60_000
  clearSnoozeTimer(itemId)
  store.patch((draft) => {
    draft.pending = draft.pending.map((entry) =>
      entry.id === itemId ? { ...entry, snoozedUntil: until } : entry
    )
  })
  const timer = setTimeout(() => {
    snoozeTimers.delete(itemId)
    const fresh = store.get().pending.find((entry) => entry.id === itemId)
    if (!fresh) return
    store.patch((draft) => {
      draft.pending = draft.pending.map((entry) => {
        if (entry.id !== itemId) return entry
        const { snoozedUntil: _snoozedUntil, ...rest } = entry
        return rest
      })
    })
    log('info', `稍后提醒已到期 · ${item.sessionLabel} · ${item.tool}`)
    syncPopup('new')
    notifyApproval(fresh)
  }, clamped * 60_000)
  timer.unref?.()
  snoozeTimers.set(itemId, timer)
  log('info', `审批已稍后 ${clamped} 分钟 · ${item.sessionLabel} · ${item.tool}`)
  syncPopup('none')
  updateBadge()
}

function pauseApproval(itemId: string, paused: boolean): void {
  const item = store.get().pending.find((entry) => entry.id === itemId)
  if (!item) return
  if (paused) {
    if (item.paused) return
    const remainingMs =
      server.pause(itemId)?.remainingMs ?? Math.max(0, item.timeoutAt - Date.now())
    clearLocalTimeout(itemId)
    store.patch((draft) => {
      draft.pending = draft.pending.map((entry) =>
        entry.id === itemId
          ? {
              ...entry,
              paused: true,
              pausedRemainingMs: remainingMs,
              // Paused items sort last and must never look "urgent".
              timeoutAt: Number.MAX_SAFE_INTEGER
            }
          : entry
      )
    })
    log('info', `倒计时已暂停 · ${item.sessionLabel} · 剩余 ${Math.ceil(remainingMs / 1000)}s`)
  } else {
    if (!item.paused) return
    const remainingMs = Math.max(0, item.pausedRemainingMs || 0)
    const resumed = server.resume(itemId, remainingMs)
    if (!resumed) {
      // Test/demo approvals do not go through the HTTP server.
      scheduleLocalTimeoutMs(itemId, remainingMs)
    }
    store.patch((draft) => {
      draft.pending = draft.pending.map((entry) =>
        entry.id === itemId
          ? {
              ...entry,
              paused: false,
              pausedRemainingMs: 0,
              timeoutAt: resumed?.timeoutAt ?? Date.now() + remainingMs
            }
          : entry
      )
    })
    log('info', `倒计时已恢复 · ${item.sessionLabel} · ${Math.ceil(remainingMs / 1000)}s`)
  }
  syncPopup('none')
}

function acknowledgeExpired(id?: string): void {
  store.clearExpired(id)
  log('info', id ? '已确认一条回退提示' : '已确认全部回退提示')
  updateBadge()
  syncPopup()
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

function muted(key: string): boolean {
  return sessions.isMuted(key)
}

function inQuietHours(): boolean {
  const prefs = store.get().prefs
  if (!prefs.quietHoursEnabled) return false
  return isWithinQuietHours(Date.now(), prefs.quietHoursStart, prefs.quietHoursEnd)
}

/** Popup/notification identity helpers: prefer the registry's stable title. */
function sessionTitleFor(item: ApprovalItem): string {
  return (
    store.get().sessions.find((session) => session.key === item.sessionKey)?.title ||
    item.sessionLabel
  )
}

function sessionTaskFor(item: ApprovalItem): string {
  return (
    store.get().sessions.find((session) => session.key === item.sessionKey)?.task || item.task
  )
}

function flushApprovalNotifications(): void {
  notificationTimer = null
  const items = notificationQueue
  notificationQueue = []
  if (items.length === 0 || !Notification.isSupported() || headless) return
  const uniqueSessions = new Set(items.map((item) => item.sessionKey))
  const title =
    items.length === 1
      ? `${sessionTitleFor(items[0])} 等待审批`
      : `${uniqueSessions.size} 个会话 · ${items.length} 条待审批`
  const body = items
    .slice(0, 4)
    .map((item) => {
      const task = sessionTaskFor(item)
      const command = (approvalCommand(item) || item.message).slice(0, 60)
      return `${sessionTitleFor(item)} · ${task ? `${task.slice(0, 40)} · ` : ''}${item.tool}：${command}`
    })
    .join('\n')
  const notification = new Notification({
    title,
    body,
    silent: true,
    urgency: items.some((item) => item.risk.level === 'high') ? 'critical' : 'normal'
  })
  notification.on('click', () => focusSession(items[0].sessionKey))
  notification.show()
}

function notifyApproval(item: ApprovalItem): void {
  const state = store.get()
  const sessionMuted = muted(item.sessionKey)
  if (sessionMuted) {
    log('info', `${item.sessionLabel} 已静音提醒；审批仍在队列中`)
    return
  }
  const quiet = inQuietHours()
  const highRisk = item.risk.level === 'high'
  if (!headless && state.prefs.sound && (!quiet || highRisk) && Date.now() - lastBeepAt > 1200) {
    lastBeepAt = Date.now()
    shell.beep()
  }
  const supported = Notification.isSupported()
  if (
    !canDeliverSystemNotification({
      headless,
      enabled: state.prefs.systemNotifications,
      muted: sessionMuted,
      supported,
      quietHours: quiet,
      highRisk
    })
  ) {
    if (!headless && !state.prefs.systemNotifications) {
      log('info', `${item.sessionLabel} 系统通知已关闭；审批仍在队列中`)
    } else if (!headless && quiet) {
      log('info', `${item.sessionLabel} 当前处于免打扰时段；审批仍在队列中`)
    }
    return
  }
  if (popupWindow?.isFocused()) return
  notificationQueue.push(item)
  if (notificationTimer) return
  notificationTimer = setTimeout(flushApprovalNotifications, 1200)
}

function notifyTimeout(item: ApprovalItem): void {
  const state = store.get()
  if (
    !canDeliverSystemNotification({
      headless,
      enabled: state.prefs.systemNotifications,
      muted: muted(item.sessionKey),
      supported: Notification.isSupported(),
      quietHours: inQuietHours(),
      highRisk: false
    })
  ) {
    return
  }
  if (popupWindow?.isVisible()) return
  const task = sessionTaskFor(item)
  const notification = new Notification({
    title: '审批已回退终端',
    body: `${sessionTitleFor(item)}${task ? ` · ${task.slice(0, 50)}` : ''} · ${item.tool} 未在 ${item.timeoutSec}s 内处理`,
    silent: true
  })
  notification.on('click', () => sendUiCommand('inbox'))
  notification.show()
}

function clearCompletionNotice(): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  if (store.get().notice) store.setNotice(null)
}

function showCompletionNotice(notice: CompletionNotice): void {
  store.setNotice(notice)
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    if (store.get().notice?.id !== notice.id) return
    store.setNotice(null)
    syncPopup('none')
  }, 7000)
  syncPopup('none')
}

// ---------------------------------------------------------------------------
// approval handling
// ---------------------------------------------------------------------------

function handleApproval(item: ApprovalItem): void {
  if (store.get().notice) clearCompletionNotice()
  itemCache.set(item.id, item)
  sessions.observe(item)
  refreshSessions()
  const state = store.get()
  const rule = matchingRule(state.rules, item)
  if (rule && item.risk.level !== 'high') {
    decisionSources.set(item.id, 'rule')
    decisionRules.set(item.id, rule.id)
    log('rule', `规则命中：${item.sessionLabel} · ${item.tool} · ${rule.pattern}`)
    server.respond(item.id, 'allow')
    return
  }
  if (rule && item.risk.level === 'high') {
    log('warn', `高风险操作不自动应用规则：${item.sessionLabel} · ${item.tool}`)
  }

  if (state.prefs.admissionControl) {
    const pending = state.pending
    const estimate = pending.length * 18
    const overloaded = pending.length >= state.prefs.maxPending
    const willExpire = pending.length > 0 && item.timeoutSec <= estimate + 10
    if (overloaded || willExpire) {
      decisionSources.set(item.id, 'admission')
      log(
        'warn',
        `队列无法及时处理（${pending.length} 条排队），直接回退终端 · ${item.sessionLabel} · ${item.tool}`
      )
      server.respond(item.id, 'ask')
      return
    }
  }

  store.addPending(item)
  persistPendingSnapshot()
  refreshSessions()
  log(
    'notify',
    `收到审批 · ${item.sessionLabel} · ${item.origin} · ${item.tool} · ${riskLabel(item.risk.level)} · ${item.timeoutSec}s`
  )
  syncPopup('new')
  updateBadge()
  notifyApproval(item)
}

function scheduleLocalTimeoutMs(id: string, delayMs: number): void {
  clearLocalTimeout(id)
  const timer = setTimeout(() => {
    localTimers.delete(id)
    if (store.get().pending.some((entry) => entry.id === id)) {
      respond(id, 'timeout', undefined, 'timeout')
    }
  }, Math.max(0, delayMs))
  timer.unref?.()
  localTimers.set(id, timer)
}

function scheduleLocalTimeout(id: string, seconds: number): void {
  scheduleLocalTimeoutMs(id, seconds * 1000)
}

function clearLocalTimeout(id: string): void {
  const timer = localTimers.get(id)
  if (!timer) return
  clearTimeout(timer)
  localTimers.delete(id)
}

function localApprovalItem(mode: 'approval' | 'question'): ApprovalItem {
  const id = `local_${randomUUID()}`
  const question = {
    question: '这次要部署到哪个环境？',
    multiSelect: false,
    options: [
      { label: 'Staging', description: '预发布环境，可随时回滚' },
      { label: 'Production', description: '生产环境，需要二次确认' }
    ]
  }
  const toolInput =
    mode === 'approval'
      ? { command: 'git push origin feature/approval-popup --force-with-lease' }
      : { questions: [question] }
  const tool = mode === 'approval' ? 'Bash' : 'AskUserQuestion'
  return {
    id,
    requestId: id,
    sessionId: 'a11ce000-0000-4000-8000-000000000002',
    sessionKey: '本机:a11ce000-0000-4000-8000-000000000002',
    sessionLabel: 'claude-code-notify · 本机',
    origin: '本机',
    promptId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: mode === 'approval' ? 'permission' : 'question',
    tool,
    project: 'claude-code-notify',
    cwd: '~/workspace/claude-code-notify',
    tty: '',
    terminal: '',
    task: mode === 'approval' ? '验证多会话审批弹窗的会话身份展示' : '确认部署目标环境',
    branch: 'feat/popup-identity',
    message: mode === 'approval' ? 'Claude 请求执行权限' : 'Claude 想问你一个问题',
    detail: JSON.stringify(toolInput, null, 2),
    toolInput,
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ],
    suggestions: [],
    questions: mode === 'question' ? [question] : [],
    risk: assessRisk(tool, toolInput),
    correlation: 'exact',
    createdAt: Date.now(),
    timeoutAt: Date.now() + 50 * 1000,
    timeoutSec: 50
  }
}

async function testApproval(): Promise<void> {
  const item = localApprovalItem('approval')
  const result = new Promise<string>((resolve) => {
    localApprovals.set(item.id, resolve)
  })
  itemCache.set(item.id, item)
  sessions.observe(item)
  store.addPending(item)
  refreshSessions()
  scheduleLocalTimeout(item.id, item.timeoutSec)
  log('notify', `测试审批 · ${item.sessionLabel} · ${item.tool} · 等待桌面选择`)
  syncPopup('new')
  updateBadge()
  notifyApproval(item)
  await result
}

async function testNotify(): Promise<void> {
  store.patch((draft) => {
    draft.server.notified += 1
  })
  log('notify', '测试通知 · 已将系统通知推送到通知中心')
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'Claude Code',
      body: 'Claude 正在等待你的输入',
      silent: !store.get().prefs.sound
    })
    notification.on('click', () => showMainWindow())
    notification.show()
  }
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

function createNotifyServer(): NotifyServer {
  return new NotifyServer(serverPort, store.get().server.token, {
    onApproval: handleApproval,
    onResolved: handleResolved,
    onNotify: (title, body, payload) => {
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
      const origin = typeof payload.origin === 'string' ? payload.origin : '本机'
      const key = sessions.observeSimple({
        sessionId,
        origin,
        cwd,
        project: projectName(cwd),
        tty: typeof payload.tty === 'string' ? payload.tty : '',
        terminal: typeof payload.terminal === 'string' ? payload.terminal : '',
        task: typeof payload.task === 'string' ? payload.task : '',
        branch: typeof payload.branch === 'string' ? payload.branch : ''
      })
      const notificationType = safeString(payload.notification_type)
      const notificationMatcher = safeString(payload.matcher)
      if (notificationType === 'SessionEnd' || notificationMatcher === 'SessionEnd') {
        if (key) sessions.end(key)
        refreshSessions()
        log('info', `会话已结束 · ${projectName(cwd) || '未知项目'} · ${sessionId.slice(0, 8)}`)
        return
      }
      store.patch((draft) => {
        draft.server.notified += 1
      })
      const state = store.get()
      const supported = Notification.isSupported()
      const sessionMuted = key ? sessions.isMuted(key) : false
      const deliver = canDeliverSystemNotification({
        headless,
        enabled: state.prefs.systemNotifications,
        muted: sessionMuted,
        supported,
        quietHours: inQuietHours(),
        highRisk: false
      })
      log('notify', `通知 · ${projectName(cwd) || '未知项目'} · ${title}`)
      refreshSessions()
      const sessionInfo = key
        ? store.get().sessions.find((session) => session.key === key)
        : undefined
      const isStop = notificationType === 'Stop' || notificationMatcher === 'Stop'
      const effectiveTitle =
        isStop && sessionInfo?.title ? `${sessionInfo.title} 已完成` : title
      const hasPending =
        state.pending.length > 0 || state.expired.length > 0
      if (
        shouldShowCompletionPopup({
          isStop,
          mode: state.prefs.mode,
          headless,
          muted: sessionMuted,
          hasPending
        })
      ) {
        showCompletionNotice({
          id: `notice_${randomUUID()}`,
          title: effectiveTitle,
          body,
          sessionKey: key || '',
          createdAt: Date.now(),
          sessionTitle: sessionInfo?.title,
          sessionLabel: sessionInfo?.label,
          shortId: sessionInfo?.shortId,
          color: sessionInfo?.color,
          task: sessionInfo?.task,
          branch: sessionInfo?.branch
        })
        log('notify', `完成弹窗 · ${projectName(cwd) || '未知项目'} · ${effectiveTitle}`)
        return
      }
      if (!deliver) {
        const reason = headless
          ? '无界面模式'
          : !supported
            ? '当前系统不支持通知'
            : !state.prefs.systemNotifications
              ? '系统通知已关闭'
              : '会话已静音'
        log(
          'info',
          `未推送系统通知 · ${reason} · ${projectName(cwd) || '未知项目'} · ${title}`
        )
        return
      }
      const notification = new Notification({
        title: effectiveTitle,
        body,
        silent: !state.prefs.sound
      })
      notification.on('click', () => {
        if (key) focusSession(key)
        else showMainWindow()
      })
      notification.show()
    },
    onLog: (level, message) => log(level, message)
  })
}

function bindHost(): string {
  return serverBindMode === 'loopback' ? '127.0.0.1' : '0.0.0.0'
}

async function startServer(): Promise<boolean> {
  try {
    await server.start(bindHost())
    store.setListening(true)
    store.setServerError('')
    store.setNetwork({
      port: server.getPort(),
      bindMode: serverBindMode,
      conflict: false,
      error: '',
      addresses: listAddresses()
    })
    log(
      'info',
      `HTTP 服务已启动 · ${bindHost()}:${server.getPort()} · Bearer Token 校验开启`
    )
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const message = code === 'EADDRINUSE' ? `端口 ${serverPort} 已被占用` : String(error)
    store.setListening(false)
    store.setServerError(message)
    store.setNetwork({
      port: serverPort,
      bindMode: serverBindMode,
      conflict: code === 'EADDRINUSE',
      error: message,
      addresses: listAddresses()
    })
    log('error', `HTTP 服务启动失败：${message}`)
    return false
  }
}

function cancelLocalApprovals(): void {
  if (!store) return
  for (const [itemId, resolve] of [...localApprovals]) {
    localApprovals.delete(itemId)
    try {
      resolve('cancelled')
    } catch {
      // the awaiter is gone; still clean the pending entry below
    }
    const item =
      store.get().pending.find((entry) => entry.id === itemId) || itemCache.get(itemId) || null
    if (!item) continue
    decisionSources.set(itemId, 'server-stop')
    store.removePending(itemId)
    finishItem(item, 'cancelled', 'server-stop')
  }
}

async function stopServer(reason: 'manual' | 'restart' = 'manual'): Promise<void> {
  if (!server || !store) return
  for (const item of store.get().pending) {
    decisionSources.set(item.id, reason === 'manual' ? 'server-stop' : 'server-stop')
  }
  await server.stop()
  // Local test approvals never touch the HTTP server, so cancel them here too.
  cancelLocalApprovals()
  store.setListening(false)
  log('warn', 'HTTP 服务已停止，后续审批将回退到终端')
  updateBadge()
}

async function toggleServer(): Promise<void> {
  if (server.isListening()) {
    const pending = store.get().pending.length
    if (pending > 0) {
      const confirmed = await confirm({
        type: 'warning',
        title: '停止服务',
        message: `将停止 HTTP 服务，并取消 ${pending} 条待审批`,
        detail: '所有等待中的会话会回退到终端继续；可以再次点击“启动服务”恢复。',
        buttons: ['停止服务', '取消'],
        defaultId: 1,
        cancelId: 1
      })
      if (!confirmed) return
    }
    await stopServer('manual')
    return
  }
  await startServer()
}

async function applyNetwork(port: number, bindMode: BindMode): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, message: '端口需在 1024–65535 之间' }
  }
  if (port === serverPort && bindMode === serverBindMode && server.isListening()) {
    return { ok: true, message: '服务配置未变化' }
  }
  const previousPort = serverPort
  const previousBindMode = serverBindMode
  const targetHost = (mode: BindMode): string => (mode === 'loopback' ? '127.0.0.1' : '0.0.0.0')
  // Same port + only a bind change can be applied by restarting on the port we
  // already own, so skip the preflight. Any new port (or a stopped service) is
  // checked before we tear down a working listener.
  const needsPortCheck = port !== previousPort || !server.isListening()
  if (needsPortCheck) {
    const free = await isPortFree(port, targetHost(bindMode))
    if (!free) {
      const conflict =
        port === previousPort
          ? `端口 ${port} 当前不可用`
          : `端口 ${port} 已被占用或不可用`
      log('warn', `网络设置未应用：${conflict}，保留 ${previousBindMode === 'loopback' ? '127.0.0.1' : '0.0.0.0'}:${previousPort}`)
      return {
        ok: false,
        message: `${conflict}，已保留原配置 ${previousBindMode === 'loopback' ? '127.0.0.1' : '0.0.0.0'}:${previousPort}`
      }
    }
  }
  const pending = store.get().pending.length
  if (pending > 0) {
    const confirmed = await confirm({
      type: 'warning',
      title: '应用网络设置',
      message: `修改端口/监听范围需要重启服务，将取消 ${pending} 条待审批`,
      buttons: ['应用并重启', '取消'],
      defaultId: 1,
      cancelId: 1
    })
    if (!confirmed) return { ok: false, message: '已取消' }
  }
  await stopServer('restart')
  serverPort = port
  serverBindMode = bindMode
  server = createNotifyServer()
  const ok = await startServer()
  if (!ok) {
    const failure = store.get().network.error || '启动失败'
    // Roll back to the last known-good listener so a typo/conflict does not
    // leave the app without an HTTP endpoint.
    serverPort = previousPort
    serverBindMode = previousBindMode
    server = createNotifyServer()
    const restored = await startServer()
    const previousHost = previousBindMode === 'loopback' ? '127.0.0.1' : '0.0.0.0'
    if (!restored) {
      const rollbackError = store.get().network.error || failure
      log('error', `端口 ${port} 启动失败（${failure}），回滚到 ${previousHost}:${previousPort} 也失败：${rollbackError}`)
      return {
        ok: false,
        message: `端口 ${port} 启动失败（${failure}），已回滚到原端口 ${previousPort} 但恢复失败，请手动重启服务`
      }
    }
    log('warn', `端口 ${port} 启动失败（${failure}），已回滚到 ${previousHost}:${previousPort}`)
    return {
      ok: false,
      message: `端口 ${port} 启动失败（${failure}），已回滚到原端口 ${previousPort}`
    }
  }
  store.setPrefs({ port, bindMode })
  saveUiConfig({ port, bindMode })
  refreshDeployHealth()
  log('info', `监听配置已更新 · ${bindHost()}:${port}`)
  if (store.get().deploy.localMode || profiles.some((profile) => profile.status === 'deployed')) {
    store.setToast('端口已变更，需要重新接入或部署')
  }
  return { ok: true, message: `服务已监听 ${bindHost()}:${port}` }
}

// ---------------------------------------------------------------------------
// local deployment
// ---------------------------------------------------------------------------

function localDeployOptions(mode: 'popup' | 'notify') {
  return {
    mode,
    token: store.get().server.token,
    port: store.get().server.port,
    timeoutSec: store.get().prefs.timeoutSec,
    writeEnv: false,
    envShells: [] as string[],
    origin: '本机'
  }
}

function applyLocalDeploy(mode: 'popup' | 'notify'): { ok: boolean; message: string } {
  try {
    const result = deployLocal(localDeployOptions(mode), (level, message) => log(level, message))
    store.setDeploy({
      status: 'deployed',
      host: '本机 · 127.0.0.1',
      hooks: mode === 'popup' ? 2 : 1,
      message: `本机已接入 · ${result.settingsPath}`,
      localMode: mode,
      localHooks: mode === 'popup' ? 2 : 1,
      hookVersion: HOOK_VERSION,
      hookStale: false,
      modeMismatch: mode !== store.get().prefs.mode
    })
    refreshDeployHealth()
    store.setToast('本机接入完成')
    refreshSessions()
    return { ok: true, message: '本机接入完成' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', `本机接入失败：${message}`)
    store.setToast('本机接入失败，见日志')
    return { ok: false, message }
  }
}

async function localDeployWithConfirm(mode: 'popup' | 'notify'): Promise<{ ok: boolean; canceled?: boolean; message: string }> {
  const confirmed = await confirm({
    type: 'question',
    title: '接入本机',
    message: '将钩子写入本机 Claude Code 配置？',
    detail:
      `目标：~/.claude/settings.json\n` +
      `模式：${mode === 'popup' ? '置顶弹窗' : '系统通知'}\n` +
      '会先备份现有 settings.json，并保留第三方 hooks。',
    buttons: ['接入本机', '取消'],
    defaultId: 0,
    cancelId: 1
  })
  if (!confirmed) return { ok: false, canceled: true, message: '已取消' }
  return applyLocalDeploy(mode)
}

async function localRemoveWithConfirm(): Promise<{ ok: boolean; message: string }> {
  const state = detectLocalState()
  if (!state.mode) return { ok: false, message: '本机尚未接入' }
  const confirmed = await confirm({
    type: 'warning',
    title: '断开本机接入',
    message: '将从本机 settings.json 移除 Claude Notify 钩子',
    detail:
      `模式：${state.mode === 'popup' ? '置顶弹窗' : '系统通知'}\n` +
      `备份：${state.latestBackup || '无'}\n` +
      '第三方 hooks 会保留；本机钩子脚本与配置会被删除。',
    buttons: ['断开本机', '取消'],
    defaultId: 1,
    cancelId: 1
  })
  if (!confirmed) return { ok: false, message: '已取消' }
  try {
    const result = removeLocalDeploy(
      { writeEnv: true, envShells: ['bash', 'zsh', 'csh', 'fish'] },
      (level, message) => log(level, message)
    )
    store.setDeploy({
      status: profiles.some((profile) => profile.status === 'deployed') ? 'deployed' : 'idle',
      host: '',
      hooks: 0,
      message: `本机已断开 · 移除 ${result.removedHooks} 个钩子`,
      localMode: null,
      localHooks: 0,
      hookStale: false,
      modeMismatch: computeModeMismatch()
    })
    refreshDeployHealth()
    store.setToast('本机接入已断开')
    return { ok: true, message: '本机接入已断开' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', `断开本机失败：${message}`)
    return { ok: false, message }
  }
}

async function localRestoreWithConfirm(): Promise<{ ok: boolean; message: string }> {
  const state = detectLocalState()
  if (!state.latestBackup) return { ok: false, message: '没有可恢复的备份' }
  const confirmed = await confirm({
    type: 'warning',
    title: '恢复本机配置',
    message: '恢复最近一次备份的 settings.json？',
    detail: `备份：${state.latestBackup}\n当前文件会另存为 .pre-restore.时间戳。`,
    buttons: ['恢复备份', '取消'],
    defaultId: 1,
    cancelId: 1
  })
  if (!confirmed) return { ok: false, message: '已取消' }
  try {
    const result = restoreLocalBackup(undefined, (level, message) => log(level, message))
    const next = detectLocalState()
    store.setDeploy({
      localMode: next.mode,
      localHooks: next.mode ? (next.mode === 'popup' ? 2 : 1) : 0,
      hookVersion: next.version,
      hookStale: next.stale,
      message: `已恢复设置 · ${result.restoredFrom}`,
      modeMismatch: computeModeMismatch()
    })
    refreshDeployHealth()
    store.setToast('已恢复本机配置')
    return { ok: true, message: '已恢复本机配置' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', `恢复本机配置失败：${message}`)
    return { ok: false, message }
  }
}

// ---------------------------------------------------------------------------
// remote deployment
// ---------------------------------------------------------------------------

let activeDeployController: AbortController | null = null

const DEPLOY_BUSY_SUMMARY = '已有部署进行中，请等待当前部署完成或先取消'

type DeployOperationStart =
  | { started: true; controller: AbortController }
  | { started: false; result: DeployResult }

function beginDeployOperation(): DeployOperationStart {
  if (activeDeployController) {
    return {
      started: false,
      result: { success: false, summary: DEPLOY_BUSY_SUMMARY, connectivity: false }
    }
  }
  const controller = new AbortController()
  activeDeployController = controller
  return { started: true, controller }
}

function finishDeployOperation(controller: AbortController): void {
  if (activeDeployController === controller) activeDeployController = null
}

function knownFingerprintFor(host: string, port: number): string {
  return knownHosts[`${host}:${port}`]?.fingerprint || ''
}

function rememberFingerprint(host: string, port: number, fingerprint: string): void {
  if (!fingerprint) return
  knownHosts[`${host}:${port}`] = { fingerprint, addedAt: Date.now() }
  saveKnownHosts(knownHosts)
}

function toDeployConfig(form: DeployFormConfig, trustHost = false) {
  return {
    ...form,
    host: form.host.trim(),
    username: form.username.trim(),
    sshPort: Number(form.sshPort),
    callbackIp: form.callbackIp.trim(),
    callbackPort: Number(form.callbackPort),
    hookTimeout: Number(form.hookTimeout),
    token: store.get().server.token,
    approvalTimeout: Math.max(5, Number(form.hookTimeout) - 60),
    origin: form.origin?.trim() || form.host,
    envImport: Boolean(form.envImport),
    envShells: form.envImport ? form.envShells : [],
    hostFingerprint:
      form.hostFingerprint || knownFingerprintFor(form.host.trim(), Number(form.sshPort)),
    trustHost
  }
}

function profileId(form: DeployFormConfig): string {
  return `${form.username.trim()}@${form.host.trim()}:${Number(form.sshPort)}`
}

function upsertProfile(form: DeployFormConfig, result: DeployResult): DeployProfile {
  const id = profileId(form)
  const profile: DeployProfile = {
    id,
    name: form.origin?.trim() || form.host.trim(),
    origin: form.origin?.trim() || form.host.trim(),
    host: form.host.trim(),
    sshPort: Number(form.sshPort),
    username: form.username.trim(),
    authMethod: form.authMethod,
    ...(form.authMethod === 'key' && form.keyPath ? { keyPath: form.keyPath } : {}),
    mode: form.mode,
    callbackIp: form.callbackIp.trim(),
    callbackPort: Number(form.callbackPort),
    hookTimeout: Number(form.hookTimeout),
    toolMatcher: form.toolMatcher?.trim() || '',
    lastDeployAt: Date.now(),
    status: result.success ? 'deployed' : 'failed',
    hooks: result.success ? (form.mode === 'popup' ? 2 : 1) : 0,
    hookVersion: HOOK_VERSION,
    tokenFingerprint: fingerprintToken(store.get().server.token),
    ...(result.success ? {} : { lastError: result.summary })
  }
  profiles = [profile, ...profiles.filter((entry) => entry.id !== id)].slice(0, 20)
  saveDeployProfiles(profiles)
  store.setDeploy({ profiles })
  return profile
}

function saveDeployFormCache(form: DeployFormConfig): void {
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
    origin: form.origin,
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
}

async function deployStart(
  form: DeployFormConfig,
  progress: (level: LogLevel, message: string) => void,
  signal?: AbortSignal
): Promise<DeployResult> {
  saveDeployFormCache(form)
  const config = toDeployConfig(form)
  if (!config.hostFingerprint) {
    const probe = await testSshConnection(
      {
        ...config,
        hostFingerprint: undefined,
        trustHost: false
      },
      signal
    )
    if (signal?.aborted) {
      return { success: false, summary: '部署已取消', connectivity: false }
    }
    if (probe.fingerprint) {
      return {
        success: false,
        summary: `首次连接需要确认主机指纹 ${probe.fingerprint}；请先“测试连接”并确认。`,
        connectivity: false
      }
    }
    return {
      success: false,
      summary: probe.message || '无法建立 SSH 连接',
      connectivity: false
    }
  }

  store.setDeploy({
    status: 'running',
    host: profileId(form),
    hooks: 0,
    message: '正在连接…'
  })
  log('deploy', `开始部署 · ${profileId(form)} · ${form.mode === 'popup' ? '弹窗' : '通知'}`)
  try {
    const result = await deployToServer(config, progress, signal)
    const profile = upsertProfile(form, result)
    rememberFingerprint(form.host.trim(), Number(form.sshPort), result.fingerprint)
    store.setDeploy({
      status: 'deployed',
      host: `${profile.username}@${profile.host}:${profile.sshPort}`,
      hooks: profile.hooks,
      message: result.connectivity
        ? `上次成功 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
        : '已写入，连通性未通过',
      modeMismatch: computeModeMismatch()
    })
    refreshDeployHealth()
    if (result.connectivity) store.setToast('部署完成 · 钩子已生效')
    else store.setToast('已写入，但回调连通性未通过')
    return {
      success: result.success,
      summary: result.summary,
      connectivity: result.connectivity
    }
  } catch (error) {
    const message = humanizeSshError(error)
    if (isDeployCancelled(error)) {
      log('warn', '部署已取消')
      store.setDeploy({
        status: 'error',
        host: profileId(form),
        hooks: 0,
        message: '部署已取消'
      })
      return { success: false, summary: message, connectivity: false }
    }
    log('error', `部署失败：${message}`)
    upsertProfile(form, { success: false, summary: message, connectivity: false })
    store.setDeploy({ status: 'error', host: profileId(form), hooks: 0, message: '部署失败' })
    return { success: false, summary: message, connectivity: false }
  }
}

async function deployRemove(
  form: DeployFormConfig,
  progress: (level: LogLevel, message: string) => void,
  signal?: AbortSignal
): Promise<DeployResult> {
  const config = toDeployConfig(form)
  if (!config.hostFingerprint) {
    const probe = await testSshConnection({ ...config, hostFingerprint: undefined }, signal)
    if (signal?.aborted) {
      return { success: false, summary: '部署已取消', connectivity: false }
    }
    if (probe.fingerprint) {
      return {
        success: false,
        summary: `需要先确认主机指纹 ${probe.fingerprint}`,
        connectivity: false
      }
    }
    return { success: false, summary: probe.message, connectivity: false }
  }
  try {
    const result = await removeDeployFromServer(config, progress, signal)
    const id = profileId(form)
    profiles = profiles.map((profile) =>
      profile.id === id ? { ...profile, status: 'unknown', hooks: 0 } : profile
    )
    saveDeployProfiles(profiles)
    store.setDeploy({
      profiles,
      status: profiles.some((profile) => profile.status === 'deployed') ? 'deployed' : 'idle',
      message: '服务器钩子已移除',
      modeMismatch: computeModeMismatch()
    })
    refreshDeployHealth()
    store.setToast('服务器接入已断开')
    return { success: true, summary: result.summary, connectivity: false }
  } catch (error) {
    const message = humanizeSshError(error)
    if (isDeployCancelled(error)) {
      log('warn', '移除服务器钩子已取消')
      return { success: false, summary: message, connectivity: false }
    }
    log('error', `移除服务器钩子失败：${message}`)
    return { success: false, summary: message, connectivity: false }
  }
}

// ---------------------------------------------------------------------------
// misc actions
// ---------------------------------------------------------------------------

async function confirm(options: Electron.MessageBoxOptions): Promise<boolean> {
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
  return result.response === 0
}

async function regenerateToken(): Promise<void> {
  const deployed =
    Boolean(store.get().deploy.localMode) ||
    profiles.some((profile) => profile.status === 'deployed')
  const confirmed = await confirm({
    type: 'warning',
    title: '重新生成 Token',
    message: '旧 Token 会立即失效',
    detail: deployed
      ? '本机接入和服务器钩子会继续使用旧 Token；生成后需要重新接入/部署。'
      : '当前没有检测到已部署的钩子。',
    buttons: ['重新生成', '取消'],
    defaultId: 1,
    cancelId: 1
  })
  if (!confirmed) return
  const token = randomBytes(24).toString('hex')
  store.setToken(token)
  server.setToken(token)
  try {
    saveToken(token)
  } catch (error) {
    log('error', `Token 写入失败：${String(error)}`)
  }
  refreshDeployHealth()
  log('warn', 'Token 已重新生成，旧 Token 立即失效；请重新部署服务器钩子')
  store.setToast('Token 已更新，需重新部署')
  if (!deployed) return
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Token 已更新',
    message: '旧的部署已失效，需要重新接入或部署',
    detail: store.get().deploy.localMode
      ? '本机接入会继续使用旧 Token；可以立即重新接入本机。远程服务器需要重新部署。'
      : '服务器钩子会继续使用旧 Token；请重新执行“部署并验证”。',
    buttons: store.get().deploy.localMode ? ['知道了', '立即重新接入本机'] : ['知道了'],
    defaultId: 0,
    cancelId: 0
  }
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
  if (result.response === 1 && store.get().deploy.localMode) {
    applyLocalDeploy(store.get().prefs.mode)
  }
}

function applyPrefs(incoming: Partial<Prefs>): void {
  const patch: Partial<Prefs> = { ...incoming }
  if (typeof patch.timeoutSec === 'number') {
    patch.timeoutSec = Math.max(15, Math.min(600, Math.round(patch.timeoutSec)))
  }
  if (typeof patch.maxPending === 'number') {
    patch.maxPending = Math.max(1, Math.min(30, Math.round(patch.maxPending)))
  }
  delete patch.port
  delete patch.bindMode
  store.setPrefs(patch)
  saveUiConfig(patch as Partial<UiConfig>)
  if (patch.theme) {
    const previous = currentTheme
    nativeTheme.themeSource = patch.theme
    currentTheme = resolveTheme()
    if (previous !== currentTheme) applyWindowTheme()
  }
  if (patch.position) {
    popupAnchor = null
    saveUiConfig({ popupAnchor: null, popupHeight: null, popupPosition: null })
    syncPopup('none')
  }
  if (patch.localIp) {
    store.setNetwork({
      addresses: listAddresses().map((address) => ({
        ...address,
        preferred: address.address === patch.localIp
      }))
    })
  }
  if (patch.mode || patch.localIp) {
    refreshDeployHealth()
  }
  log('info', `偏好已更新 · 位置=${store.get().prefs.position} · 模式=${store.get().prefs.mode}`)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('state:get', () => store.get())
  ipcMain.handle(
    'approval:respond',
    (_event, id: string, decision: string, extra?: ApprovalExtra) => {
      respond(id, decision, extra, 'popup')
    }
  )
  ipcMain.handle(
    'approval:respond-many',
    (_event, ids: string[], decision: string, extra?: ApprovalExtra) => {
      respondMany(Array.isArray(ids) ? ids : [], decision, extra, 'popup')
    }
  )
  ipcMain.handle('approval:pause', (_event, id: string, paused: boolean) => {
    pauseApproval(id, Boolean(paused))
  })
  ipcMain.handle('approval:snooze', (_event, id: string, minutes: number) => {
    snoozeApproval(id, Number(minutes))
  })
  ipcMain.handle('approval:acknowledge', (_event, id?: string) => {
    acknowledgeExpired(id)
  })
  ipcMain.handle('notice:dismiss', () => {
    clearCompletionNotice()
    syncPopup('none')
  })
  ipcMain.handle('approval:select', (_event, id: string) => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      syncPopup('manual')
      popupWindow.webContents.send('popup:select', id)
    }
  })
  ipcMain.handle('server:toggle', () => toggleServer())
  ipcMain.handle('test:notify', () => testNotify())
  ipcMain.handle('test:approval', () => testApproval())
  ipcMain.handle('clipboard:write', (_event, text: string) => {
    clipboard.writeText(text)
    store.setToast('已复制到剪贴板')
  })
  ipcMain.handle('token:regenerate', () => regenerateToken())
  ipcMain.handle('deploy:cache', (): DeployFormConfig & { password?: string } => {
    const cache = loadDeployCache()
    return { ...(cache as DeployFormConfig), password: decryptSecret(cache.passwordEncrypted) }
  })
  ipcMain.handle('security:info', (): SecurityInfo => ({
    available: secureStorageAvailable(),
    label: secureStorageLabel()
  }))
  ipcMain.handle('deploy:pick-key', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择私钥文件',
      properties: ['openFile'],
      defaultPath: join(app.getPath('home'), '.ssh')
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('deploy:test', async (_event, form: DeployFormConfig): Promise<DeployTestResult> => {
    const config = toDeployConfig(form)
    const result = await testSshConnection(config)
    if (result.ok && result.fingerprint) {
      rememberFingerprint(form.host.trim(), Number(form.sshPort), result.fingerprint)
    }
    return result
  })
  const deployProgress =
    (event: Electron.IpcMainInvokeEvent) =>
    (level: LogLevel, message: string): void => {
      log(level, message)
      if (!event.sender.isDestroyed()) event.sender.send('deploy:progress', { level, message })
    }
  ipcMain.handle('deploy:start', async (event, form: DeployFormConfig): Promise<DeployResult> => {
    const operation = beginDeployOperation()
    if (!operation.started) return operation.result
    try {
      return await deployStart(form, deployProgress(event), operation.controller.signal)
    } finally {
      finishDeployOperation(operation.controller)
    }
  })
  ipcMain.handle('deploy:remove', async (event, form: DeployFormConfig): Promise<DeployResult> => {
    const operation = beginDeployOperation()
    if (!operation.started) return operation.result
    try {
      return await deployRemove(form, deployProgress(event), operation.controller.signal)
    } finally {
      finishDeployOperation(operation.controller)
    }
  })
  ipcMain.handle('deploy:restore', async (event, form: DeployFormConfig): Promise<DeployResult> => {
    const operation = beginDeployOperation()
    if (!operation.started) return operation.result
    try {
      const config = toDeployConfig(form)
      if (!config.hostFingerprint) {
        return { success: false, summary: '请先测试连接并确认主机指纹', connectivity: false }
      }
      try {
        const result = await restoreDeployBackup(
          config,
          deployProgress(event),
          operation.controller.signal
        )
        store.setToast(result.summary)
        return { success: result.success, summary: result.summary, connectivity: false }
      } catch (error) {
        const message = humanizeSshError(error)
        if (isDeployCancelled(error)) {
          log('warn', '恢复服务器备份已取消')
          return { success: false, summary: message, connectivity: false }
        }
        log('error', `恢复服务器备份失败：${message}`)
        return { success: false, summary: message, connectivity: false }
      }
    } finally {
      finishDeployOperation(operation.controller)
    }
  })
  ipcMain.handle('deploy:profile-remove', (_event, id: string) => {
    const target = profiles.find((profile) => profile.id === id)
    if (!target) return
    profiles = profiles.filter((profile) => profile.id !== id)
    saveDeployProfiles(profiles)
    store.setDeploy({
      profiles,
      status: profiles.some((profile) => profile.status === 'deployed') ? 'deployed' : 'idle',
      message: `已删除部署目标 ${target.origin || target.name}`
    })
    refreshDeployHealth()
    log('info', `已删除部署目标 ${target.id}`)
  })
  ipcMain.handle('deploy:profile-check', async (_event, id: string): Promise<DeployResult> => {
    const profile = profiles.find((entry) => entry.id === id)
    if (!profile) return { success: false, summary: '部署目标不存在', connectivity: false }
    const cache = loadDeployCache()
    const sameCache =
      cache.host === profile.host && cache.username === profile.username
    const config = {
      ...profile,
      password: sameCache ? decryptSecret(cache.passwordEncrypted) : undefined,
      keyPath: sameCache ? cache.keyPath : profile.keyPath,
      keyPassphrase: undefined,
      approvalTimeout: Math.max(5, profile.hookTimeout - 60),
      envImport: false,
      envShells: [],
      token: store.get().server.token,
      hostFingerprint: knownFingerprintFor(profile.host, profile.sshPort)
    }
    if (profile.authMethod === 'password' && !config.password) {
      return {
        success: false,
        summary: '请先选中该目标并重新填写密码，再检查连接',
        connectivity: false
      }
    }
    if (profile.authMethod === 'key' && !config.keyPath) {
      return {
        success: false,
        summary: '请先选中该目标并重新选择私钥，再检查连接',
        connectivity: false
      }
    }
    try {
      const result = await testSshConnection(config)
      const summary = result.ok
        ? result.connectivity === false
          ? `SSH 正常，但回调不可达${result.connectivityMessage ? `：${result.connectivityMessage}` : ''}`
          : 'SSH 与回调均正常'
        : result.message
      profiles = profiles.map((entry) =>
        entry.id === id
          ? { ...entry, lastError: result.ok ? undefined : summary, status: result.ok ? entry.status : 'failed' }
          : entry
      )
      saveDeployProfiles(profiles)
      store.setDeploy({ profiles })
      return { success: result.ok, summary, connectivity: Boolean(result.connectivity) }
    } catch (error) {
      const summary = humanizeSshError(error)
      return { success: false, summary, connectivity: false }
    }
  })
  ipcMain.handle('deploy:cancel', (): { ok: boolean; message?: string } => {
    if (!activeDeployController) {
      return { ok: false, message: '当前没有进行中的部署' }
    }
    activeDeployController.abort()
    log('warn', '正在取消部署…')
    return { ok: true, message: '正在取消部署…' }
  })
  ipcMain.handle('local:status', () => {
    const state = detectLocalState()
    return { deployed: Boolean(state.mode), mode: state.mode, stale: state.stale, version: state.version }
  })
  ipcMain.handle('local:deploy', (_event, mode: 'popup' | 'notify') => localDeployWithConfirm(mode))
  ipcMain.handle('local:remove', () => localRemoveWithConfirm())
  ipcMain.handle('local:restore', () => localRestoreWithConfirm())
  ipcMain.handle('prefs:set', (_event, patch: Partial<Prefs>) => applyPrefs(patch))
  ipcMain.handle('network:apply', (_event, config: { port: number; bindMode: BindMode }) =>
    applyNetwork(config.port, config.bindMode)
  )
  ipcMain.handle('session:rename', (_event, key: string, label: string) => {
    sessions.rename(key, label)
    refreshSessions()
    log('info', `会话已重命名：${label}`)
  })
  ipcMain.handle('session:mute', (_event, key: string, minutes: number) => {
    sessions.mute(key, minutes)
    refreshSessions()
    const session = store.get().sessions.find((entry) => entry.key === key)
    store.setToast(
      minutes > 0
        ? `${session?.label || '会话'} 已静音 ${minutes} 分钟`
        : `${session?.label || '会话'} 已取消静音`
    )
  })
  ipcMain.handle(
    'rules:add',
    (
      _event,
      input: {
        scope: RuleScope
        tool: string
        pattern: string
        project?: string
        sessionKey?: string
        origin?: string
        expiresAt?: number
      }
    ) => {
      const message = validateRule(input)
      if (message) throw new Error(message)
      const origin = (input.origin ?? '').trim().slice(0, 80)
      const rule: ApprovalRule = {
        id: randomUUID(),
        scope: input.scope,
        tool: input.tool.trim(),
        pattern: input.pattern.trim() || '*',
        project: input.project,
        sessionKey: input.sessionKey,
        ...(origin ? { origin } : {}),
        ...(typeof input.expiresAt === 'number' && input.expiresAt > Date.now()
          ? { expiresAt: input.expiresAt }
          : {}),
        createdAt: Date.now(),
        enabled: true
      }
      rules = [rule, ...rules].slice(0, 100)
      saveRules(rules)
      store.setRules(rules)
      log('rule', `新增自动规则：${rule.tool} · ${rule.pattern}`)
      store.setToast('规则已保存')
    }
  )
  ipcMain.handle('rules:remove', (_event, id: string) => {
    rules = rules.filter((rule) => rule.id !== id)
    saveRules(rules)
    store.setRules(rules)
    store.setToast('规则已删除')
  })
  ipcMain.handle('rules:toggle', (_event, id: string) => {
    rules = rules.map((rule) =>
      rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
    )
    saveRules(rules)
    store.setRules(rules)
  })
  ipcMain.handle('history:export', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出审批历史',
      defaultPath: join(app.getPath('downloads'), 'claude-notify-history.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, message: '已取消' }
    try {
      const count = history.exportCsv(result.filePath)
      return { ok: true, message: `已导出 ${count} 条记录` }
    } catch (error) {
      return { ok: false, message: `导出失败：${(error as Error).message}` }
    }
  })
  ipcMain.handle('history:export-json', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出审批历史 JSON',
      defaultPath: join(app.getPath('downloads'), 'claude-notify-history.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, message: '已取消' }
    try {
      const count = history.exportJson(result.filePath)
      return { ok: true, message: `已导出 ${count} 条记录` }
    } catch (error) {
      return { ok: false, message: `导出失败：${(error as Error).message}` }
    }
  })
  ipcMain.handle('history:clear', async () => {
    const confirmed = await confirm({
      type: 'warning',
      title: '清空审批历史',
      message: '将删除本机保存的审批历史记录',
      detail: '历史文件会被清空，此操作不可撤销。',
      buttons: ['清空', '取消'],
      defaultId: 1,
      cancelId: 1
    })
    if (!confirmed) return
    history.clear()
    store.setHistory([])
    refreshSessions()
    store.setToast('审批历史已清空')
  })
  ipcMain.handle('logs:clear', () => {
    store.clearLogs()
  })
  ipcMain.handle('file:open', async (_event, target: string) => {
    if (typeof target !== 'string' || !target.trim()) return
    const expanded = target.startsWith('~')
      ? join(app.getPath('home'), target.slice(1))
      : target
    if (!existsSync(expanded)) {
      store.setToast('文件不存在或已被移动')
      return
    }
    await shell.openPath(expanded)
  })
  ipcMain.handle('logs:open', () => {
    if (logFile && existsSync(logFile)) shell.showItemInFolder(logFile)
  })
  ipcMain.handle('logs:open-file', async () => {
    if (logFile && existsSync(logFile)) await shell.openPath(logFile)
  })
  ipcMain.handle('external:open', async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle('update:check', async () => {
    store.setUpdate({ status: 'checking' })
    const result = await checkForAppUpdate(app.getVersion())
    store.setUpdate(result)
    if (result.status === 'available') store.setToast(result.message || '发现新版本')
    return result
  })
  ipcMain.handle('update:download', async () => {
    const result = await downloadAppUpdate()
    store.setUpdate(result)
    return result
  })
  ipcMain.handle('update:install', () => {
    installAppUpdate()
  })
  ipcMain.handle('onboarding:finish', () => {
    store.setOnboarding(true)
    saveUiConfig({ onboardingDone: true })
  })
  ipcMain.handle('window:hide', () => mainWindow?.hide())
  ipcMain.on('popup:resize', (_event, height: number) => {
    if (!popupWindow || popupWindow.isDestroyed()) return
    const bounds = popupWindow.getBounds()
    const display = screen.getDisplayNearestPoint({
      x: bounds.x,
      y: bounds.y + bounds.height
    })
    const area = display.workArea
    const maxHeight = Math.max(300, Math.min(820, area.height - 16))
    const nextHeight = Math.max(300, Math.min(maxHeight, Math.round(height)))
    if (Math.abs(nextHeight - bounds.height) < 2) return
    suppressMoveSave = true
    const bottom = Math.min(bounds.y + bounds.height, area.y + area.height)
    const nextY = Math.max(area.y, bottom - nextHeight)
    popupWindow.setBounds({
      x: bounds.x,
      y: nextY,
      width: POPUP_WIDTH,
      height: nextHeight
    })
    popupAnchor = { x: bounds.x, bottom: nextY + nextHeight }
    setTimeout(() => {
      suppressMoveSave = false
    }, 120)
  })
  ipcMain.handle('app:quit', () => app.quit())
}

// ---------------------------------------------------------------------------
// self test / capture
// ---------------------------------------------------------------------------

async function runSelfTest(): Promise<void> {
  const results: Record<string, unknown> = {}
  const base = `http://127.0.0.1:${server.getPort()}`
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
      session_id: 'selftest-session',
      origin: 'self-test',
      tool_name: 'Bash',
      cwd: '/tmp/claude-notify-selftest',
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
  results.pendingLabel = latestApproval
    ? `${latestApproval.sessionLabel}:${latestApproval.tool}`
    : null
  if (latestApproval) respond(latestApproval.id, 'allow', undefined, 'popup')
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

  const questionPayload = {
    request_id: 'req_question',
    session_id: 'selftest-question',
    origin: 'self-test',
    kind: 'question',
    tool_name: 'AskUserQuestion',
    cwd: '/tmp/claude-notify-selftest',
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
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ]
  }
  const questionPromise = postApproval(questionPayload)
  const questionItem = await waitPending('req_question')
  results.questionShown = Boolean(questionItem)
  if (questionItem) {
    respond(
      questionItem.id,
      'answer',
      { answers: [{ question: '选择部署环境', selected: ['Staging'], text: '' }] },
      'popup'
    )
  }
  results.question = await questionPromise

  const suggestionPromise = postApproval({
    request_id: 'req_suggestion',
    session_id: 'selftest-suggestion',
    origin: 'self-test',
    tool_name: 'Bash',
    cwd: '/tmp/claude-notify-selftest',
    message: 'Claude 请求执行权限',
    tool_input: { command: 'git status' },
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ],
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
  if (suggestionItem) respond(suggestionItem.id, 'suggestion', { index: 0 }, 'popup')
  results.suggestion = await suggestionPromise

  const resolvedPromise = postApproval({
    request_id: 'req_resolved',
    session_id: 'selftest-terminal',
    origin: 'self-test',
    tool_name: 'Edit',
    cwd: '/tmp/claude-notify-selftest',
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
    session_id: 'selftest-timeout',
    origin: 'self-test',
    tool_name: 'Bash',
    cwd: '/tmp/claude-notify-selftest',
    message: 'timeout test',
    timeout_seconds: 5
  })
  await delay(200)
  results.timeout = {
    status: timeoutResponse.status,
    body: timeoutResponse.body,
    elapsed: Date.now() - timeoutStarted
  }
  results.expiredShown = store.get().expired.length > 0
  acknowledgeExpired()
  results.expiredAcknowledged = store.get().expired.length === 0
  results.historyCount = store.get().history.length
  results.sessionCount = store.get().sessions.length
  store.clearExpired()

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
    callbackPort: Number(process.env.DEPLOY_CALLBACK_PORT || serverPort),
    hookTimeout: 300,
    approvalTimeout: 240,
    toolMatcher: '',
    origin: process.env.DEPLOY_ORIGIN || 'self-test',
    envImport: false,
    envShells: [] as string[],
    token: store.get().server.token,
    trustHost: true
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

function captureItem(
  overrides: Partial<ApprovalItem> & Pick<ApprovalItem, 'id' | 'sessionId' | 'sessionKey' | 'sessionLabel'>
): ApprovalItem {
  const toolInput = overrides.toolInput || { command: 'git status' }
  const tool = overrides.tool || 'Bash'
  return {
    requestId: `req_${overrides.id}`,
    origin: '本机',
    promptId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'permission',
    tool,
    project: 'claude-code-notify',
    cwd: '~/workspace/claude-code-notify',
    tty: '',
    terminal: '',
    task: '',
    branch: '',
    message: 'Claude 请求执行权限',
    detail: JSON.stringify(toolInput, null, 2),
    toolInput,
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' }
    ],
    suggestions: [],
    questions: [],
    risk: assessRisk(tool, toolInput),
    correlation: 'exact',
    createdAt: Date.now(),
    timeoutAt: Date.now() + 39000,
    timeoutSec: 60,
    ...overrides
  }
}

async function runCapture(): Promise<void> {
  const now = Date.now()
  store.patch((draft) => {
    draft.server.notified = 18
    draft.onboarding = { done: false }
    draft.prefs.position = 'cursor'
    draft.deploy = {
      ...draft.deploy,
      status: 'deployed',
      host: 'deploy@192.168.1.20:22',
      hooks: 2,
      message: '上次成功 16:15',
      localMode: 'popup',
      localHooks: 2,
      hookVersion: HOOK_VERSION,
      hookStale: false,
      profiles: [
        {
          id: 'deploy@192.168.1.20:22',
          name: 'prod-api',
          origin: 'prod-api',
          host: '192.168.1.20',
          sshPort: 22,
          username: 'deploy',
          authMethod: 'key',
          mode: 'popup',
          callbackIp: '192.168.1.77',
          callbackPort: 18765,
          hookTimeout: 300,
          toolMatcher: '',
          lastDeployAt: now - 3600_000,
          status: 'deployed',
          hooks: 2,
          hookVersion: HOOK_VERSION
        }
      ]
    }
  })
  log('deploy', 'settings.json 合并完成 · 旧 PreToolUse 残留已清理')
  log('notify', '通知 · 前端 · 等待输入 · 已推送系统通知')
  log('allow', '后端 · prod-api · Bash · git status · 允许 · 2.6s')

  await delay(1000)
  if (!mainWindow) throw new Error('main window missing')
  const onboardingImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'onboarding.png'), onboardingImage.toPNG())

  store.setOnboarding(true)
  await delay(500)
  const mainImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'main.png'), mainImage.toPNG())

  const clickButton = async (label: string): Promise<boolean> =>
    Boolean(
      await mainWindow!.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === ${JSON.stringify(label)})?.click() ?? true`
      )
    )

  await clickButton('状态')
  await delay(600)
  if (!(await mainWindow!.webContents.executeJavaScript(`!!document.querySelector('.status-modal')`))) {
    throw new Error('status modal missing')
  }
  const statusImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'status.png'), statusImage.toPNG())
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.status-modal .modal-close')?.click()`
  )
  await delay(300)

  await clickButton('设置')
  await delay(600)
  const settingsImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'settings.png'), settingsImage.toPNG())
  await mainWindow.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.settings-tabs button')).find((button) => button.textContent.trim() === '提醒')?.click()`
  )
  await delay(400)
  const reminderImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'settings-reminder.png'), reminderImage.toPNG())
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.settings-modal .modal-close')?.click()`
  )
  await delay(300)

  await clickButton('部署')
  await delay(500)
  const deployImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'deploy.png'), deployImage.toPNG())
  await mainWindow.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('远程部署'))?.click()`
  )
  await delay(700)
  const deployDialogImage = await mainWindow.webContents.capturePage()
  writeFileSync(
    join(app.getAppPath(), 'artifacts', 'deploy-dialog.png'),
    deployDialogImage.toPNG()
  )
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.deploy-modal:not(.deploy-panel-modal) .modal-close')?.click()`
  )
  await delay(300)
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.deploy-panel-modal .modal-close')?.click()`
  )
  await delay(300)

  const clickTab = async (label: string): Promise<void> => {
    await mainWindow!.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.tabs button')).find((button) => button.textContent.includes(${JSON.stringify(label)}))?.click()`
    )
  }
  store.setHistory([
    {
      id: 'demo-history-1',
      ts: now - 62000,
      sessionKey: '本机:session-front',
      sessionLabel: '前端 · iTerm2 · ttys004',
      origin: '本机',
      project: 'claude-code-notify',
      tool: 'Bash',
      message: 'Claude 请求执行权限',
      command: 'git status',
      decision: 'allow',
      source: 'popup',
      latencyMs: 2600,
      risk: 'low'
    },
    {
      id: 'demo-history-2',
      ts: now - 121000,
      sessionKey: 'prod-api:session-infra',
      sessionLabel: 'infra · prod-api',
      origin: 'prod-api',
      project: 'infra',
      tool: 'Bash',
      message: 'Claude 请求执行权限',
      command: 'terraform destroy -auto-approve',
      decision: 'deny',
      source: 'popup',
      latencyMs: 5400,
      risk: 'high'
    },
    {
      id: 'demo-history-3',
      ts: now - 186000,
      sessionKey: '本机:session-api',
      sessionLabel: '后端 · VS Code · ttys007',
      origin: '本机',
      project: 'backend-api',
      tool: 'Edit',
      message: 'Claude 请求修改文件',
      command: 'src/server/config.ts',
      decision: 'timeout',
      source: 'timeout',
      latencyMs: 60000,
      risk: 'medium'
    }
  ])
  await clickTab('历史')
  await delay(500)
  const historyImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'history.png'), historyImage.toPNG())
  await clickTab('日志')
  await delay(500)
  const logsImage = await mainWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'logs.png'), logsImage.toPNG())

  const first = captureItem({
    id: 'apr_capture',
    sessionId: '3c9f2a10-77bd-4a3e-9c7a-1234567890ab',
    sessionKey: '本机:3c9f2a10-77bd-4a3e-9c7a-1234567890ab',
    sessionLabel: 'claude-code-notify · ttys004',
    tty: 'ttys004',
    terminal: 'iTerm2',
    project: 'claude-code-notify',
    cwd: '~/workspace/claude-code-notify',
    task: '修复多会话弹窗无法区分任务的问题',
    branch: 'feat/popup-identity',
    toolInput: { command: 'git push origin feature/approval-popup --force-with-lease' },
    detail: 'git push origin feature/approval-popup --force-with-lease',
    message: 'Claude 请求执行权限',
    createdAt: now - 5000,
    timeoutAt: now + 47000,
    timeoutSec: 60
  })
  const second = captureItem({
    id: 'apr_capture_2',
    sessionId: '81bd5c44-1f2e-4a6b-8c0d-abcdef123456',
    sessionKey: '本机:81bd5c44-1f2e-4a6b-8c0d-abcdef123456',
    sessionLabel: 'claude-code-notify · ttys007',
    tty: 'ttys007',
    terminal: 'VS Code',
    project: 'claude-code-notify',
    cwd: '~/worktrees/claude-code-notify',
    task: '给审批接口补上 trace_id 透传',
    branch: 'fix/trace-id',
    tool: 'Edit',
    toolInput: {
      file_path: 'src/server/config.ts',
      old_string: 'const port = 8080',
      new_string: 'const port = 9090'
    },
    risk: assessRisk('Edit', { file_path: 'src/server/config.ts' }),
    createdAt: now - 1000,
    timeoutAt: now + 90000,
    timeoutSec: 120
  })
  const third = captureItem({
    id: 'apr_capture_3',
    sessionId: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70',
    sessionKey: 'prod-api:d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70',
    sessionLabel: 'infra · prod-api',
    origin: 'prod-api',
    project: 'infra',
    cwd: '~/srv/infra',
    task: '重建 staging 集群并清理旧 PVC',
    branch: 'main',
    toolInput: { command: 'terraform destroy -auto-approve' },
    createdAt: now,
    timeoutAt: now + 30000,
    timeoutSec: 60
  })
  sessions.observe(first)
  sessions.observe(second)
  sessions.observe(third)
  store.addPending(first)
  store.addPending(second)
  store.addPending(third)
  refreshSessions()
  syncPopup('none')
  await clickTab('待审批')
  await delay(700)
  const inboxImage = await mainWindow!.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'inbox.png'), inboxImage.toPNG())
  if (!popupWindow) throw new Error('popup window missing')
  await delay(1200)
  const popupImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup.png'), popupImage.toPNG())

  pauseApproval(third.id, true)
  syncPopup('none')
  popupWindow.webContents.send('popup:select', third.id)
  await delay(600)
  const pausedImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup-paused.png'), pausedImage.toPNG())

  store.setPending([third])
  syncPopup('none')
  await delay(1000)
  const riskImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup-risk.png'), riskImage.toPNG())

  const question = captureItem({
    id: 'apr_question',
    sessionId: '3c9f2a10-77bd-4a3e-9c7a-1234567890ab',
    sessionKey: '本机:3c9f2a10-77bd-4a3e-9c7a-1234567890ab',
    sessionLabel: '前端 · iTerm2 · ttys004',
    kind: 'question',
    tool: 'AskUserQuestion',
    message: 'Claude 想问你一个问题',
    toolInput: { questions: [] },
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
    timeoutAt: Date.now() + 39000
  })
  store.setPending([question])
  syncPopup('none')
  await delay(1000)
  const questionImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup-question.png'), questionImage.toPNG())

  store.setPending([])
  store.addExpired(first)
  store.addExpired(second)
  syncPopup('none')
  await delay(1000)
  const expiredImage = await popupWindow.webContents.capturePage()
  writeFileSync(join(app.getAppPath(), 'artifacts', 'popup-expired.png'), expiredImage.toPNG())

  console.log('CAPTURE_DONE')
  app.exit(0)
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function bootstrap(): Promise<void> {
  installPermissionRequestGuard()
  ensureDataDir()
  logFile = join(appDataDir(), 'claude-notify.log')
  pendingSnapshotPath = join(appDataDir(), 'pending.json')
  rotateLogIfNeeded()
  try {
    if (existsSync(logFile)) chmodSync(logFile, 0o600)
  } catch {
    // best-effort
  }

  const token = loadOrCreateToken()
  const addresses = listAddresses()
  const ui = loadUiConfig()
  const envPort = Number(process.env.CLAUDE_NOTIFY_PORT)
  const initialPort =
    Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535
      ? envPort
      : typeof ui.port === 'number'
        ? ui.port
        : DEFAULT_PORT
  const initialBind: BindMode = ui.bindMode === 'loopback' ? 'loopback' : 'all'
  serverPort = initialPort
  serverBindMode = initialBind
  const preferred =
    typeof ui.localIp === 'string' &&
    ui.localIp &&
    addresses.some((entry) => entry.address === ui.localIp)
      ? ui.localIp
      : addresses.find((entry) => entry.preferred)?.address || preferredAddress()
  const prefs: Partial<Prefs> = {
    position: ui.position || ui.popup_screen || 'cursor',
    mode: ui.mode === 'notify' ? 'notify' : 'popup',
    timeoutSec: typeof ui.timeoutSec === 'number' ? ui.timeoutSec : 240,
    fontStyle: ui.fontStyle || 'system',
    fontSize: ui.fontSize || 'normal',
    theme:
      process.env.CLAUDE_NOTIFY_THEME === 'light'
        ? 'light'
        : process.env.CLAUDE_NOTIFY_THEME === 'dark'
          ? 'dark'
          : ui.theme || 'system',
    focusPolicy: ui.focusPolicy || 'first',
    sound: ui.sound !== false,
    systemNotifications: ui.systemNotifications !== false,
    enterConfirmsHighRisk: ui.enterConfirmsHighRisk !== false,
    bindMode: initialBind,
    port: initialPort,
    localIp: preferred,
    admissionControl: ui.admissionControl !== false,
    maxPending: typeof ui.maxPending === 'number' ? ui.maxPending : 8,
    quietHoursEnabled: ui.quietHoursEnabled === true,
    quietHoursStart: typeof ui.quietHoursStart === 'string' ? ui.quietHoursStart : '22:00',
    quietHoursEnd: typeof ui.quietHoursEnd === 'string' ? ui.quietHoursEnd : '08:00',
    autoUpdate: ui.autoUpdate !== false
  }
  // Legacy configs only stored a top-left corner. Without the matching height
  // we cannot recover the real bottom edge, so drop it and fall back to the
  // bottom-right corner instead of preserving a potentially drifted position.
  const legacyPosition =
    ui.popupPosition &&
    typeof ui.popupHeight === 'number' &&
    Number.isFinite(ui.popupPosition.x) &&
    Number.isFinite(ui.popupPosition.y)
      ? ui.popupPosition
      : null
  popupAnchor =
    ui.popupAnchor &&
    Number.isFinite(ui.popupAnchor.x) &&
    Number.isFinite(ui.popupAnchor.bottom)
      ? ui.popupAnchor
      : legacyPosition
        ? anchorFromLegacyPosition(legacyPosition, ui.popupHeight ?? undefined)
        : null
  nativeTheme.themeSource = prefs.theme || 'system'
  currentTheme =
    prefs.theme === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : prefs.theme === 'light'
        ? 'light'
        : 'dark'

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    copyright: 'Claude Code Notify'
  })

  store = new Store({
    token,
    port: initialPort,
    localIp: preferred,
    localIps: addresses.map((entry) => entry.address),
    version: app.getVersion(),
    platform: process.platform,
    bindMode: initialBind,
    prefs
  })
  sessions = new SessionRegistry()
  history = new HistoryStore()
  history.load()
  rules = loadRules()
  profiles = loadDeployProfiles()
  knownHosts = loadKnownHosts()
  store.setRules(rules)
  store.setHistory(history.get())
  store.setOnboarding(Boolean(ui.onboardingDone))

  const pendingSnapshot = readJsonFile<Array<{ id: string; sessionLabel?: string }>>(
    pendingSnapshotPath,
    []
  )
  if (Array.isArray(pendingSnapshot) && pendingSnapshot.length > 0) {
    log(
      'warn',
      `上次退出时还有 ${pendingSnapshot.length} 条审批未处理；这些请求已随进程结束回退终端`
    )
    store.setToast(`上次退出时有 ${pendingSnapshot.length} 条审批未处理`)
    writeJsonFile(pendingSnapshotPath, [])
  }

  const local = detectLocalState()
  const localMode = local.mode
  const deployedProfiles = profiles
    .filter((profile) => profile.status === 'deployed')
    .sort((left, right) => (right.lastDeployAt || 0) - (left.lastDeployAt || 0))
  const latestProfile = deployedProfiles[0] || null
  const initialDeploy = {
    status: (localMode ? 'deployed' : latestProfile ? 'deployed' : 'idle') as
      | 'deployed'
      | 'idle',
    host: localMode
      ? '本机 · 127.0.0.1'
      : latestProfile
        ? `${latestProfile.username}@${latestProfile.host}:${latestProfile.sshPort}`
        : '',
    hooks: localMode ? (localMode === 'popup' ? 2 : 1) : latestProfile?.hooks || 0,
    message: localMode
      ? `本机已接入 · ${localMode === 'popup' ? '置顶弹窗' : '系统通知'}`
      : latestProfile
        ? `上次成功 ${new Date(latestProfile.lastDeployAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
        : '尚未部署',
    localMode,
    localHooks: localMode ? (localMode === 'popup' ? 2 : 1) : 0,
    hookVersion: local.version,
    hookStale: local.stale,
    modeMismatch: false,
    profiles,
    drift: []
  }
  initialDeploy.modeMismatch =
    Boolean(localMode && localMode !== prefs.mode) ||
    deployedProfiles.some((profile) => profile.mode !== prefs.mode)
  store.setDeploy(initialDeploy)
  store.setNetwork({
    addresses,
    port: initialPort,
    bindMode: initialBind,
    conflict: false,
    error: ''
  })
  refreshDeployHealth()
  refreshSessions()
  store.subscribe(broadcast)

  initAutoUpdater(
    (update) => store.setUpdate(update),
    (level, message) => log(level, message)
  )

  server = createNotifyServer()
  await startServer()
  registerIpc()
  mainWindow = createMainWindow()
  createAppMenu()

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
  updateBadge()
  nativeTheme.on('updated', () => {
    if (store.get().prefs.theme !== 'system' || headless) return
    const next = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    if (next === currentTheme) return
    currentTheme = next
    applyWindowTheme()
  })
  if (!headless) showMainWindow()

  if (!headless && store.get().prefs.autoUpdate && canUseNativeUpdater()) {
    const timer = setTimeout(() => {
      if (!store.get().prefs.autoUpdate) return
      void checkForAppUpdate(app.getVersion()).then((result) => {
        store.setUpdate(result)
        if (result.status === 'available') log('notify', result.message || '发现新版本')
      })
    }, 5000)
    timer.unref?.()
  }

  if (local.stale) {
    if (local.mode && !isDemo) {
      const updated = applyLocalDeploy(local.mode)
      if (updated.ok) {
        log('info', `本机钩子版本 ${local.version || '未知'} 已自动更新到 ${HOOK_VERSION}`)
      } else {
        log('warn', `本机钩子自动更新失败：${updated.message}，请手动重新接入`)
      }
    } else {
      log('warn', `本机钩子版本 ${local.version || '未知'} 低于当前版本 ${HOOK_VERSION}，建议重新接入`)
    }
  }
  if (store.get().deploy.modeMismatch) {
    log('warn', '当前模式与已部署钩子不一致，需要重新接入或部署')
  }

  if (isDemo) {
    await delay(900)
    const item = captureItem({
      id: 'local_demo',
      sessionId: 'a11ce000-0000-4000-8000-000000000001',
      sessionKey: '本机:a11ce000-0000-4000-8000-000000000001',
      sessionLabel: 'claude-code-notify · iTerm2',
      task: '验证多会话审批弹窗的会话身份展示',
      branch: 'feat/popup-identity',
      toolInput: { command: 'git push origin feature/approval-popup --force-with-lease' },
      timeoutAt: Date.now() + 39000,
      timeoutSec: 60
    })
    localApprovals.set(item.id, () => undefined)
    itemCache.set(item.id, item)
    sessions.observe(item)
    store.addPending(item)
    refreshSessions()
    scheduleLocalTimeout(item.id, item.timeoutSec)
    syncPopup('new')
    updateBadge()
    if (process.argv.includes('--fullscreen-demo')) {
      setTimeout(() => mainWindow?.setFullScreen(true), 1800)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    showMainWindow()
  })
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error('[bootstrap]', error)
  dialog.showErrorBox('Claude Notify 启动失败', String(error))
  app.exit(1)
})

app.on('window-all-closed', () => {
  // Keep running in the tray on every platform; quit is explicit.
})

app.on('before-quit', (event) => {
  if (quitAllowed) return
  // Cancel the default quit first, run async cleanup, then quit for real.
  event.preventDefault()
  if (quitting) return
  quitting = true
  void (async () => {
    try {
      await stopServer('manual')
    } catch (error) {
      console.error('[shutdown] stop server', error)
    }
    try {
      cancelLocalApprovals()
    } catch (error) {
      console.error('[shutdown] local approvals', error)
    }
    try {
      sessions?.flush()
    } catch (error) {
      console.error('[shutdown] session metadata', error)
    }
    try {
      flushBroadcast()
    } catch (error) {
      console.error('[shutdown] broadcast', error)
    }
    try {
      persistPendingSnapshot()
    } catch (error) {
      console.error('[shutdown] pending snapshot', error)
    }
    quitAllowed = true
    app.quit()
  })()
})
