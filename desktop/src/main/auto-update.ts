import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import type { AppUpdateInfo, LogLevel } from '../shared/types'
import { detectPortableBuild } from './portable'
import {
  checkLatestVersion,
  compareVersions,
  fetchLatestDesktopRelease,
  normalizeVersionTag,
  selectReleaseAsset
} from './update'

export const RELEASES_URL = 'https://github.com/hfwang0318/claude-code-notify/releases'
const PENDING_INSTALL_FILE = 'update-pending.json'

interface PendingInstallRecord {
  version?: string
  requestedAt?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type UpdateSink = (info: AppUpdateInfo) => void
type LogSink = (level: LogLevel, message: string) => void

let wired = false
let sink: UpdateSink | null = null
let logSink: LogSink | null = null
let nativeAvailable = false
/** Latest version announced by `update-available`. */
let pendingVersion = ''
/**
 * Settled state after `update-downloaded`. `downloadUpdate()` resolves *after*
 * that event, so callers must report this instead of a stale "downloading"
 * state that would overwrite it and hide the restart button.
 */
let downloadedInfo: AppUpdateInfo | null = null

/**
 * Portable builds are zips, not NSIS installations. electron-builder's
 * portable target sets PORTABLE_EXECUTABLE_DIR; our win-unpacked zip carries
 * RUN-ME.bat/portable.marker next to the executable. Detect all three so a
 * portable build never accidentally downloads an NSIS installer.
 */
export function isPortableBuild(): boolean {
  return detectPortableBuild()
}

/** Native updater only exists in an installed packaged build with a feed. */
export function canUseNativeUpdater(): boolean {
  return app.isPackaged && !isPortableBuild()
}

function pendingInstallPath(): string {
  return join(app.getPath('userData'), PENDING_INSTALL_FILE)
}

/**
 * Remember which version we are about to install. If the installer never
 * replaces the running build (files locked by another process, missing
 * elevation, app killed first), the next launch can tell the user instead of
 * failing silently.
 */
export function recordPendingInstall(version: string): void {
  if (!version) return
  try {
    const file = pendingInstallPath()
    mkdirSync(dirname(file), { recursive: true })
    const record: PendingInstallRecord = { version, requestedAt: Date.now() }
    writeFileSync(file, JSON.stringify(record))
  } catch (error) {
    logSink?.('warn', `记录更新安装状态失败：${errorMessage(error)}`)
  }
}

/**
 * Consume the pending-install marker once at startup. Returns a user-facing
 * message when the previous install attempt did not take effect.
 */
export function takeFailedInstallNotice(): string | null {
  const file = pendingInstallPath()
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    unlinkSync(file)
  } catch {
    // best-effort cleanup
  }
  try {
    const record = JSON.parse(raw) as PendingInstallRecord
    const target = normalizeVersionTag(record.version || '')
    if (!target) return null
    // A newer build is already running (update applied, or the user installed
    // a newer version manually), so there is nothing to report.
    if (compareVersions(normalizeVersionTag(app.getVersion()), target) >= 0) return null
    return `上次更新到 ${target} 未完成（当前 ${app.getVersion()}）。安装程序可能被占用或权限不足，请在设置中重试或到发布页手动下载。`
  } catch {
    return null
  }
}

export function initAutoUpdater(onUpdate: UpdateSink, onLog: LogSink): void {
  sink = onUpdate
  logSink = onLog
  nativeAvailable = canUseNativeUpdater()
  if (!nativeAvailable || wired) return
  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  // electron-updater logs installer spawn failures ("Cannot run installer:
  // error code ...") to its own logger; keep them in our log file so a failed
  // Windows install can be diagnosed after the fact.
  autoUpdater.logger = {
    info: (message?: unknown) => logSink?.('info', `[updater] ${String(message)}`),
    warn: (message?: unknown) => logSink?.('warn', `[updater] ${String(message)}`),
    error: (message?: unknown) => logSink?.('warn', `[updater] ${String(message)}`),
    debug: () => {}
  }
  autoUpdater.on('checking-for-update', () => {
    sink?.({ status: 'checking', message: '正在检查更新…' })
  })
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version
    downloadedInfo = null
    sink?.({
      status: 'available',
      latest: info.version,
      message: `发现新版本 ${info.version}`,
      url: RELEASES_URL,
      installable: true
    })
    logSink?.('info', `发现新版本 ${info.version}`)
  })
  autoUpdater.on('update-not-available', () => {
    sink?.({
      status: 'latest',
      message: `已是最新版本（${app.getVersion()}）`,
      url: RELEASES_URL
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    sink?.({
      status: 'downloading',
      progress: Math.max(0, Math.min(100, Math.round(progress.percent))),
      message: `下载更新 ${Math.round(progress.percent)}%`
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloadedInfo = {
      status: 'downloaded',
      latest: info.version,
      message: `更新 ${info.version} 已下载，重启后安装`,
      url: RELEASES_URL,
      installable: true,
      progress: 100
    }
    sink?.(downloadedInfo)
    logSink?.('notify', `更新 ${info.version} 已下载`)
    // Also covers the install-on-quit path: if the installer never replaces
    // this build, the next launch reports it instead of failing silently.
    recordPendingInstall(info.version)
  })
  autoUpdater.on('error', (error) => {
    downloadedInfo = null
    const message = errorMessage(error)
    sink?.({
      status: 'error',
      message: `自动更新不可用：${message}`,
      url: RELEASES_URL,
      manual: true,
      installable: false
    })
    logSink?.('warn', `自动更新不可用：${message}`)
  })
}

export async function checkForAppUpdate(current: string): Promise<AppUpdateInfo> {
  if (!nativeAvailable) {
    const fallback = await checkLatestVersion(current)
    return { ...fallback, manual: true, installable: false }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      const fallback = await checkLatestVersion(current)
      return { ...fallback, manual: true, installable: false }
    }
    // Never offer a downgrade: a release older than the running build (e.g. a
    // re-published or deleted release) is not an update.
    if (compareVersions(result.updateInfo.version, app.getVersion()) <= 0) {
      return {
        status: 'latest',
        latest: result.updateInfo.version,
        message: `已是最新版本（${current}）`,
        url: RELEASES_URL
      }
    }
    // Keep the restart button reachable: re-checking after a finished download
    // must not downgrade the state back to "available".
    if (
      downloadedInfo?.latest &&
      normalizeVersionTag(downloadedInfo.latest) ===
        normalizeVersionTag(result.updateInfo.version)
    ) {
      return downloadedInfo
    }
    return {
      status: 'available',
      latest: result.updateInfo.version,
      message: `发现新版本 ${result.updateInfo.version}`,
      url: RELEASES_URL
    }
  } catch (error) {
    const message = errorMessage(error)
    logSink?.('warn', `检查更新失败：${message}`)
    return {
      status: 'error',
      message: `检查更新失败：${message}`,
      url: RELEASES_URL,
      manual: true,
      installable: false
    }
  }
}

export async function downloadAppUpdate(): Promise<AppUpdateInfo> {
  if (!nativeAvailable) {
    return downloadManualUpdate()
  }
  try {
    const files = await autoUpdater.downloadUpdate()
    // `update-downloaded` fires before the promise settles; report that settled
    // state so the caller does not overwrite it with a stale "downloading".
    if (downloadedInfo) return downloadedInfo
    if (files.length === 0) {
      return {
        status: 'error',
        message: '更新包下载完成，但安装程序缺失',
        url: RELEASES_URL,
        manual: true,
        installable: false
      }
    }
    const version = pendingVersion || app.getVersion()
    downloadedInfo = {
      status: 'downloaded',
      latest: version,
      message: `更新 ${version} 已下载，重启后安装`,
      url: RELEASES_URL,
      installable: true,
      progress: 100
    }
    recordPendingInstall(version)
    return downloadedInfo
  } catch (error) {
    downloadedInfo = null
    const message = errorMessage(error)
    logSink?.('warn', `下载更新失败：${message}`)
    return {
      status: 'error',
      message: `下载更新失败：${message}`,
      url: RELEASES_URL,
      manual: true,
      installable: false
    }
  }
}

function uniqueDownloadPath(directory: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = join(directory, name)
  for (let index = 1; existsSync(candidate) && index < 100; index += 1) {
    candidate = join(directory, `${stem} (${index})${ext}`)
  }
  return candidate
}

async function downloadFile(
  url: string,
  target: string,
  onProgress: (percent: number) => void
): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'claude-code-notify' }
  })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败（HTTP ${response.status}）`)
  }
  const total = Number(response.headers.get('content-length') || 0)
  const output = createWriteStream(target, { mode: 0o600 })
  let received = 0
  let lastPercent = -1
  const finished = new Promise<void>((resolve, reject) => {
    output.once('finish', resolve)
    output.once('error', reject)
  })
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk)
      received += buffer.length
      if (!output.write(buffer)) await once(output, 'drain')
      if (total > 0) {
        const percent = Math.max(0, Math.min(100, Math.round((received / total) * 100)))
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress(percent)
        }
      }
    }
    output.end()
    await finished
  } catch (error) {
    output.destroy()
    try {
      unlinkSync(target)
    } catch {
      // best-effort cleanup
    }
    throw error
  }
}

/**
 * Portable/manual update: download the release zip next to the user's other
 * downloads. It never executes or replaces the running app.
 */
async function downloadManualUpdate(): Promise<AppUpdateInfo> {
  try {
    const release = await fetchLatestDesktopRelease()
    if (!release) {
      return {
        status: 'error',
        message: '没有找到桌面端 Release',
        url: RELEASES_URL,
        manual: true,
        installable: false
      }
    }
    const asset = selectReleaseAsset(release, process.platform)
    const latest = normalizeVersionTag(release.tag_name || '')
    if (!asset) {
      return {
        status: 'error',
        message: '该 Release 没有可下载的免安装包',
        url: release.html_url || RELEASES_URL,
        manual: true,
        installable: false
      }
    }
    const safeName = asset.name.replace(/[^\w.\- ()]+/g, '_')
    const target = uniqueDownloadPath(app.getPath('downloads'), safeName)
    logSink?.('info', `下载免安装更新 ${asset.name} → ${target}`)
    await downloadFile(asset.url, target, (percent) => {
      sink?.({
        status: 'downloading',
        progress: percent,
        message: `下载免安装包 ${percent}%`,
        manual: true,
        installable: false
      })
    })
    return {
      status: 'downloaded',
      latest,
      message: `已下载 ${safeName}，请退出应用后替换当前目录`,
      url: release.html_url || RELEASES_URL,
      manual: true,
      installable: false,
      downloadedPath: target,
      progress: 100
    }
  } catch (error) {
    const message = errorMessage(error)
    logSink?.('warn', `下载免安装包失败：${message}`)
    return {
      status: 'error',
      message: `下载免安装包失败：${message}`,
      url: RELEASES_URL,
      manual: true,
      installable: false
    }
  }
}

/**
 * Spawn the downloaded installer and quit. Returns false when the install
 * could not be started so the caller can surface a manual-download hint
 * instead of quitting into a silent no-op.
 */
export function installAppUpdate(): boolean {
  if (!nativeAvailable) {
    logSink?.('warn', '当前构建不支持自动安装，请使用下载的安装包手动更新')
    return false
  }
  try {
    logSink?.('info', '正在退出应用并安装更新…')
    autoUpdater.quitAndInstall()
    return true
  } catch (error) {
    logSink?.('warn', `启动安装程序失败：${errorMessage(error)}`)
    return false
  }
}
