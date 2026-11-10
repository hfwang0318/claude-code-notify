import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { AppUpdateInfo } from '../shared/types'
import {
  canUseNativeUpdater,
  checkForAppUpdate,
  downloadAppUpdate,
  initAutoUpdater,
  recordPendingInstall,
  takeFailedInstallNotice
} from './auto-update'

interface MockUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  on(event: string, handler: (payload: unknown) => void): void
  emit(event: string, payload?: unknown): void
  checkForUpdates: Mock
  downloadUpdate: Mock
  quitAndInstall: Mock
}

const mocks = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.7.2',
    getPath: () => mocks.userData
  }
}))

vi.mock('./portable', () => ({
  detectPortableBuild: () => false
}))

vi.mock('electron-updater', () => {
  const handlers = new Map<string, (payload: unknown) => void>()
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    on(event: string, handler: (payload: unknown) => void): void {
      handlers.set(event, handler)
    },
    emit(event: string, payload?: unknown): void {
      handlers.get(event)?.(payload)
    },
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  }
  return { autoUpdater: updater }
})

const updater = autoUpdater as unknown as MockUpdater

beforeEach(() => {
  updater.checkForUpdates.mockReset()
  updater.downloadUpdate.mockReset()
  updater.quitAndInstall.mockReset()
  mocks.userData = mkdtempSync(join(tmpdir(), 'claude-notify-update-'))
})

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true })
})

describe('downloadAppUpdate', () => {
  it('reports downloaded once the installer is ready', async () => {
    // Arrange
    const states: AppUpdateInfo[] = []
    initAutoUpdater((info) => states.push(info), () => {})
    expect(canUseNativeUpdater()).toBe(true)
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.7.3' } })
    updater.downloadUpdate.mockImplementation(async () => {
      // electron-updater emits `update-downloaded` before the promise settles.
      updater.emit('update-downloaded', { version: '0.7.3' })
      return ['/tmp/Claude.Notify.Setup.0.7.3.exe']
    })

    // Act
    await checkForAppUpdate('0.7.2')
    const result = await downloadAppUpdate()

    // Assert
    expect(result.status).toBe('downloaded')
    expect(result.latest).toBe('0.7.3')
    expect(result.installable).toBe(true)
    expect(result.progress).toBe(100)
    expect(states.at(-1)?.status).toBe('downloaded')
  })

  it('reports an error instead of a stale downloaded state when the download fails', async () => {
    // Arrange
    const states: AppUpdateInfo[] = []
    initAutoUpdater((info) => states.push(info), () => {})
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.7.4' } })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      throw new Error('net::ERR_CONNECTION_RESET')
    })

    // Act
    await checkForAppUpdate('0.7.2')
    const result = await downloadAppUpdate()

    // Assert
    expect(result.status).toBe('error')
    expect(result.installable).toBe(false)
    expect(result.message).toContain('net::ERR_CONNECTION_RESET')
    expect(states.at(-1)?.status).toBe('error')
  })

  it('keeps the restart button reachable when updates are checked again', async () => {
    // Arrange
    initAutoUpdater(() => {}, () => {})
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.7.6' } })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('update-downloaded', { version: '0.7.6' })
      return ['/tmp/Claude.Notify.Setup.0.7.6.exe']
    })
    await checkForAppUpdate('0.7.2')
    await downloadAppUpdate()

    // Act
    const again = await checkForAppUpdate('0.7.2')

    // Assert
    expect(again.status).toBe('downloaded')
    expect(again.latest).toBe('0.7.6')
    expect(again.installable).toBe(true)
  })

  it('falls back to the pending version when the event payload is unavailable', async () => {
    // Arrange
    initAutoUpdater(() => {}, () => {})
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.7.5' } })
    // Simulate the event being consumed elsewhere: no `update-downloaded` emit.
    updater.downloadUpdate.mockResolvedValue(['/tmp/Claude.Notify.Setup.0.7.5.exe'])
    updater.emit('update-available', { version: '0.7.5' })

    // Act
    await checkForAppUpdate('0.7.2')
    const result = await downloadAppUpdate()

    // Assert
    expect(result.status).toBe('downloaded')
    expect(result.latest).toBe('0.7.5')
    expect(result.installable).toBe(true)
  })
})

describe('checkForAppUpdate', () => {
  it('does not offer a downgrade when the feed is older than the running build', async () => {
    // Arrange
    initAutoUpdater(() => {}, () => {})
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.7.1' } })

    // Act
    const result = await checkForAppUpdate('0.7.2')

    // Assert
    expect(result.status).toBe('latest')
  })
})

describe('install bookkeeping', () => {
  it('reports a pending install that never replaced the running build', () => {
    // Arrange
    recordPendingInstall('0.7.3')

    // Act
    const notice = takeFailedInstallNotice()

    // Assert
    expect(notice).toContain('0.7.3')
    expect(notice).toContain('0.7.2')
    // The marker is consumed once so the warning does not repeat forever.
    expect(takeFailedInstallNotice()).toBeNull()
  })

  it('stays quiet when the installed build matches the target version', () => {
    // Arrange
    recordPendingInstall('0.7.2')

    // Act / Assert
    expect(takeFailedInstallNotice()).toBeNull()
  })

  it('stays quiet when a newer build is already running', () => {
    // Arrange
    recordPendingInstall('0.7.1')

    // Act / Assert
    expect(takeFailedInstallNotice()).toBeNull()
  })

  it('stays quiet when no install was requested', () => {
    expect(takeFailedInstallNotice()).toBeNull()
  })
})
