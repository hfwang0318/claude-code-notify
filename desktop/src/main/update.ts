import type { AppUpdateInfo } from '../shared/types'

const REPO = 'hfwang0318/claude-code-notify'
const RELEASES_URL = `https://github.com/${REPO}/releases`

function normalize(value: string): string {
  return value.trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalize(left).split('.').map((part) => Number(part) || 0)
  const rightParts = normalize(right).split('.').map((part) => Number(part) || 0)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] || 0
    const b = rightParts[index] || 0
    if (a !== b) return a > b ? 1 : -1
  }
  return 0
}

export async function checkLatestVersion(current: string): Promise<AppUpdateInfo> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
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
    const data = (await response.json()) as {
      tag_name?: string
      html_url?: string
      name?: string
    }
    const latest = normalize(data.tag_name || '')
    if (!latest) throw new Error('无法解析最新版本号')
    if (compareVersions(latest, current) > 0) {
      return {
        status: 'available',
        latest,
        url: data.html_url || RELEASES_URL,
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

export { compareVersions }
