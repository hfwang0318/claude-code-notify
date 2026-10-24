import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  newestDesktopRelease,
  normalizeVersionTag,
  selectReleaseAsset
} from './update'

describe('update version parsing', () => {
  it('strips desktop release prefixes', () => {
    expect(normalizeVersionTag('desktop-v0.5.0')).toBe('0.5.0')
    expect(normalizeVersionTag('v0.5.0')).toBe('0.5.0')
    expect(normalizeVersionTag('0.5.0')).toBe('0.5.0')
  })

  it('compares numeric versions and prereleases', () => {
    expect(compareVersions('0.5.0', '0.4.9')).toBe(1)
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareVersions('0.5.0-beta.1', '0.5.0')).toBe(-1)
    expect(compareVersions('0.5.0-beta.2', '0.5.0-beta.1')).toBe(1)
  })

  it('selects the portable zip on Windows and the arm64 zip on macOS', () => {
    const release = {
      assets: [
        { name: 'Claude.Notify.Setup.0.5.1.exe', browser_download_url: 'exe' },
        { name: 'Claude.Notify.Setup.0.5.1.exe.blockmap', browser_download_url: 'blockmap' },
        { name: 'Claude-Notify-0.5.1-win-x64-portable.zip', browser_download_url: 'win-portable' },
        { name: 'Claude.Notify-0.5.1-arm64.zip', browser_download_url: 'mac-zip' },
        { name: 'Claude.Notify-0.5.1-arm64.dmg', browser_download_url: 'dmg' }
      ]
    }
    expect(selectReleaseAsset(release, 'win32')).toEqual({
      name: 'Claude-Notify-0.5.1-win-x64-portable.zip',
      url: 'win-portable',
      size: undefined
    })
    expect(selectReleaseAsset(release, 'darwin')?.url).toBe('mac-zip')
    expect(selectReleaseAsset(release, 'win32')?.url).not.toBe('blockmap')
  })

  it('ignores unrelated releases and picks the newest desktop release', () => {
    const latest = newestDesktopRelease([
      { tag_name: 'v1.0.0-python', draft: false, prerelease: false },
      { tag_name: 'desktop-v0.4.0', draft: false, prerelease: false },
      { tag_name: 'desktop-v0.5.0', draft: false, prerelease: false },
      { tag_name: 'desktop-v9.0.0', draft: false, prerelease: true }
    ])
    expect(latest?.tag_name).toBe('desktop-v0.5.0')
  })
})
