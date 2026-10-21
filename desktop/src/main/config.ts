import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DeployMode } from './deploy/settings'

export interface DeployCache {
  mode?: DeployMode
  host?: string
  sshPort?: number
  username?: string
  authMethod?: 'password' | 'key'
  keyPath?: string
  callbackIp?: string
  callbackPort?: number
  hookTimeout?: number
  toolMatcher?: string
  rememberPassword?: boolean
  envImport?: boolean
  envShells?: string[]
  passwordEncrypted?: string
}

export interface UiConfig {
  // Python 版使用的键名，保持兼容
  popup_screen?: 'primary' | 'cursor' | 'focus'
  position?: 'primary' | 'cursor' | 'focus'
  mode?: 'popup' | 'notify'
  timeoutSec?: number
}

export function appDataDir(): string {
  return join(homedir(), '.claude-notify')
}

export function ensureDataDir(): void {
  const directory = appDataDir()
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
}

export function tokenFilePath(): string {
  return join(appDataDir(), 'token')
}

export function loadOrCreateToken(): string {
  ensureDataDir()
  const file = tokenFilePath()
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf-8').trim()
      if (existing.length >= 32) return existing
    }
  } catch {
    // fall through and regenerate
  }
  const token = randomBytes(24).toString('hex')
  saveToken(token)
  return token
}

export function saveToken(token: string): void {
  ensureDataDir()
  writeFileSync(tokenFilePath(), `${token}\n`, { mode: 0o600 })
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDataDir()
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8' })
}

export function loadDeployCache(): DeployCache {
  return readJson<DeployCache>(join(appDataDir(), 'deploy_config.json'), {})
}

export function saveDeployCache(cache: DeployCache): void {
  writeJson(join(appDataDir(), 'deploy_config.json'), cache)
}

export function loadUiConfig(): UiConfig {
  return readJson<UiConfig>(join(appDataDir(), 'ui_config.json'), {})
}

export function saveUiConfig(config: UiConfig): void {
  const current = loadUiConfig()
  const next: UiConfig = { ...current }
  if (config.position) {
    next.popup_screen = config.position
    delete next.position
  }
  if (config.mode) next.mode = config.mode
  if (typeof config.timeoutSec === 'number') next.timeoutSec = config.timeoutSec
  writeJson(join(appDataDir(), 'ui_config.json'), next)
}

export function secureStorageLabel(): string {
  if (process.platform === 'win32') return 'Windows DPAPI'
  if (process.platform === 'darwin') return 'macOS Keychain'
  return '本地安全存储'
}

export function secureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptSecret(text: string): string | null {
  if (!text || !secureStorageAvailable()) return null
  try {
    return safeStorage.encryptString(text).toString('base64')
  } catch {
    return null
  }
}

export function decryptSecret(encoded: string | undefined): string {
  if (!encoded || !secureStorageAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return ''
  }
}
