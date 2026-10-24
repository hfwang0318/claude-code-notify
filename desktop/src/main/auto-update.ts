import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createWriteStream, existsSync, unlinkSync } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import type { AppUpdateInfo, LogLevel } from '../shared/types'
import { detectPortableBuild } from './portable'
import {
  checkLatestVersion,
  fetchLatestDesktopRelease,
  normalizeVersionTag,
  selectReleaseAsset
} from './update'

const RELEASES_URL = 'https://github.com/hfwang0318/claude-code-notify/releases'

type UpdateSink = (info: AppUpdateInfo) => void
type LogSink = (level: LogLevel, message: string) => void

let wired = false
let sink: UpdateSink | null = null
let logSink: LogSink | null = null
let nativeAvailable = false

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
    sink?.({
      status: 'downloaded',
      latest: info.version,
      message: `更新 ${info.version} 已下载，重启后安装`,
      url: RELEASES_URL,
      installable: true
    })
    logSink?.('notify', `更新 ${info.version} 已下载`)
  })
  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
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
    await autoUpdater.downloadUpdate()
    return {
      status: 'downloading',
      progress: 0,
      message: '正在下载更新…',
      installable: true
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
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
    const message = error instanceof Error ? error.message : String(error)
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

export function installAppUpdate(): void {
  if (!nativeAvailable) return
  autoUpdater.quitAndInstall()
}
