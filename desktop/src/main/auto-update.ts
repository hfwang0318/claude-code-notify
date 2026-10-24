import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppUpdateInfo, LogLevel } from '../shared/types'
import { checkLatestVersion } from './update'

const RELEASES_URL = 'https://github.com/hfwang0318/claude-code-notify/releases'

type UpdateSink = (info: AppUpdateInfo) => void
type LogSink = (level: LogLevel, message: string) => void

let wired = false
let sink: UpdateSink | null = null
let logSink: LogSink | null = null
let nativeAvailable = false

/** Native updater only exists in an installed packaged build with a feed. */
export function canUseNativeUpdater(): boolean {
  if (!app.isPackaged) return false
  // The portable Windows build has no NSIS installation to update in place.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return false
  return true
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
  autoUpdater.on('checking-for-update', () => {
    sink?.({ status: 'checking', message: '正在检查更新…' })
  })
  autoUpdater.on('update-available', (info) => {
    sink?.({
      status: 'available',
      latest: info.version,
      message: `发现新版本 ${info.version}`,
      url: RELEASES_URL
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
    sink?.({
      status: 'downloaded',
      latest: info.version,
      message: `更新 ${info.version} 已下载，重启后安装`,
      url: RELEASES_URL
    })
    logSink?.('notify', `更新 ${info.version} 已下载`)
  })
  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    sink?.({
      status: 'error',
      message: `自动更新不可用：${message}`,
      url: RELEASES_URL,
      manual: true
    })
    logSink?.('warn', `自动更新不可用：${message}`)
  })
}

export async function checkForAppUpdate(current: string): Promise<AppUpdateInfo> {
  if (!nativeAvailable) {
    const fallback = await checkLatestVersion(current)
    return { ...fallback, manual: true }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      const fallback = await checkLatestVersion(current)
      return { ...fallback, manual: true }
    }
    if (result.updateInfo.version === app.getVersion()) {
      return {
        status: 'latest',
        latest: result.updateInfo.version,
        message: `已是最新版本（${current}）`,
        url: RELEASES_URL
      }
    }
    return {
      status: 'available',
      latest: result.updateInfo.version,
      message: `发现新版本 ${result.updateInfo.version}`,
      url: RELEASES_URL
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logSink?.('warn', `检查更新失败：${message}`)
    return { status: 'error', message: `检查更新失败：${message}`, url: RELEASES_URL, manual: true }
  }
}

export async function downloadAppUpdate(): Promise<AppUpdateInfo> {
  if (!nativeAvailable) {
    return {
      status: 'error',
      message: '当前是开发/未打包版本，请从发布页手动下载',
      url: RELEASES_URL,
      manual: true
    }
  }
  try {
    await autoUpdater.downloadUpdate()
    return { status: 'downloading', progress: 0, message: '正在下载更新…' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logSink?.('warn', `下载更新失败：${message}`)
    return { status: 'error', message: `下载更新失败：${message}`, url: RELEASES_URL, manual: true }
  }
}

export function installAppUpdate(): void {
  if (!nativeAvailable) return
  autoUpdater.quitAndInstall()
}
