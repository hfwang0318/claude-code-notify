import type { AppUpdateInfo } from '../shared/types'

const REPO = 'hfwang0318/claude-code-notify'
const RELEASES_URL = `https://github.com/${REPO}/releases`

/** Release tags are `desktop-v0.4.0`; legacy tags may be `v0.4.0`. */
export function normalizeVersionTag(value: string): string {
  return value
    .trim()
    .replace(/^desktop-/i, '')
    .replace(/^release-/i, '')
    .replace(/^v/i, '')
}

interface ParsedVersion {
  core: number[]
  prerelease: string
}

function parseVersion(value: string): ParsedVersion {
  const normalized = normalizeVersionTag(value)
  const [core, ...rest] = normalized.split('-')
  return {
    core: core.split('.').map((part) => Number(part) || 0),
    prerelease: rest.join('-')
  }
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  const length = Math.max(a.core.length, b.core.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.core[index] || 0
    const y = b.core[index] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease > b.prerelease ? 1 : -1
}

export interface GitHubAsset {
  name?: string
  browser_download_url?: string
  size?: number
}

export interface GitHubRelease {
  tag_name?: string
  html_url?: string
  name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GitHubAsset[]
}

export interface ReleaseAsset {
  name: string
  url: string
  size?: number
}

/** Pick the right zip for a portable/manual update; never an installer/blockmap. */
export function selectReleaseAsset(
  release: GitHubRelease | null,
  platform: NodeJS.Platform = process.platform
): ReleaseAsset | null {
  if (!release?.assets) return null
  const zips = release.assets
    .filter(
      (asset) =>
        typeof asset.name === 'string' &&
        typeof asset.browser_download_url === 'string' &&
        /\.zip$/i.test(asset.name) &&
        !/blockmap/i.test(asset.name)
    )
    .map((asset) => ({
      name: asset.name as string,
      url: asset.browser_download_url as string,
      size: asset.size
    }))
  if (platform === 'win32') {
    return zips.find((asset) => /portable/i.test(asset.name)) || null
  }
  if (platform === 'darwin') {
    return (
      zips.find((asset) => /(arm64|universal|mac)/i.test(asset.name)) ||
      zips[0] ||
      null
    )
  }
  return zips.find((asset) => /(linux|x86_64|amd64)/i.test(asset.name)) || zips[0] || null
}

/** Fetch the newest desktop release including its assets (for manual downloads). */
export async function fetchLatestDesktopRelease(): Promise<GitHubRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=30`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'claude-code-notify'
        },
        signal: controller.signal
      }
    )
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
    const data = (await response.json()) as GitHubRelease[]
    return newestDesktopRelease(Array.isArray(data) ? data : [])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the newest desktop release. Filtering matters: the repository has
 * older Python releases, and `/releases/latest` can point at any of them.
 */
export function newestDesktopRelease(
  releases: GitHubRelease[]
): GitHubRelease | null {
  const candidates = releases.filter((release) => {
    if (release.draft || release.prerelease) return false
    const tag = release.tag_name || ''
    // Only desktop releases; the repository also has older Python releases.
    return /^desktop-v\d/i.test(tag)
  })
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) =>
    compareVersions(b.tag_name || '', a.tag_name || '')
  )[0]
}

export async function checkLatestVersion(current: string): Promise<AppUpdateInfo> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=30`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'claude-code-notify'
        },
        signal: controller.signal
      }
    )
    if (!response.ok) {
      throw new Error(`GitHub 返回 ${response.status}`)
    }
    const data = (await response.json()) as GitHubRelease[]
    const release = newestDesktopRelease(Array.isArray(data) ? data : [])
    if (!release) throw new Error('没有找到桌面端 Release')
    const latest = normalizeVersionTag(release.tag_name || '')
    if (!latest) throw new Error('无法解析最新版本号')
    if (compareVersions(latest, current) > 0) {
      return {
        status: 'available',
        latest,
        url: release.html_url || RELEASES_URL,
        message: `发现新版本 ${latest}`
      }
    }
    return {
      status: 'latest',
      latest,
      url: RELEASES_URL,
      message: `已是最新版本（${current}）`
    }
  } catch (error) {
    return {
      status: 'error',
      message:
        (error as Error).name === 'AbortError'
          ? '检查更新超时，请稍后再试'
          : `检查更新失败：${(error as Error).message}`
    }
  } finally {
    clearTimeout(timer)
  }
}
