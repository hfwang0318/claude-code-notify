import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ApprovalRule,
  BindMode,
  DeployProfile,
  FocusPolicy,
  FontSize,
  FontStyle,
  ThemeMode
} from '../shared/types'
import type { PopupAnchor } from '../shared/popup-layout'
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
  origin?: string
  rememberPassword?: boolean
  envImport?: boolean
  envShells?: string[]
  passwordEncrypted?: string
}

export interface UiConfig {
  // Python 版使用的键名，保持兼容
  popup_screen?: 'primary' | 'cursor' | 'focus'
  position?: 'primary' | 'cursor' | 'focus'
  mode?: DeployMode
  timeoutSec?: number
  theme?: ThemeMode
  fontStyle?: FontStyle
  fontSize?: FontSize
  focusPolicy?: FocusPolicy
  sound?: boolean
  systemNotifications?: boolean
  enterConfirmsHighRisk?: boolean
  bindMode?: BindMode
  port?: number
  localIp?: string
  admissionControl?: boolean
  maxPending?: number
  onboardingDone?: boolean
  /** Legacy top-left position; migrated to popupAnchor on next launch. */
  popupPosition?: { x: number; y: number } | null
  /** Bottom-edge anchor for the popup, stable across height changes. */
  popupAnchor?: PopupAnchor | null
  /** Height at the time popupAnchor was saved (used to migrate legacy data). */
  popupHeight?: number | null
}

export interface SessionMeta {
  label?: string
  color?: string
  mutedUntil?: number
  lastSeen?: number
  sessionId?: string
  origin?: string
  project?: string
  cwd?: string
  tty?: string
  terminal?: string
}

export type SessionMetaMap = Record<string, SessionMeta>

export interface KnownHost {
  fingerprint: string
  addedAt: number
}

export type KnownHostMap = Record<string, KnownHost>

export function appDataDir(): string {
  return process.env.CLAUDE_NOTIFY_DATA_DIR || join(homedir(), '.claude-notify')
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

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  ensureDataDir()
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows and some filesystems do not honor POSIX modes
  }
}

export function loadDeployCache(): DeployCache {
  return readJsonFile<DeployCache>(join(appDataDir(), 'deploy_config.json'), {})
}

export function saveDeployCache(cache: DeployCache): void {
  writeJsonFile(join(appDataDir(), 'deploy_config.json'), cache)
}

export function loadUiConfig(): UiConfig {
  return readJsonFile<UiConfig>(join(appDataDir(), 'ui_config.json'), {})
}

export function saveUiConfig(patch: Partial<UiConfig>): UiConfig {
  const current = loadUiConfig()
  const next: UiConfig = { ...current, ...patch }
  if (patch.position) {
    next.popup_screen = patch.position
    delete next.position
  }
  writeJsonFile(join(appDataDir(), 'ui_config.json'), next)
  return next
}

export function loadSessionMeta(): SessionMetaMap {
  return readJsonFile<SessionMetaMap>(join(appDataDir(), 'sessions.json'), {})
}

export function saveSessionMeta(meta: SessionMetaMap): void {
  writeJsonFile(join(appDataDir(), 'sessions.json'), meta)
}

export function loadRules(): ApprovalRule[] {
  const rules = readJsonFile<ApprovalRule[]>(join(appDataDir(), 'rules.json'), [])
  return Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule.id === 'string') : []
}

export function saveRules(rules: ApprovalRule[]): void {
  writeJsonFile(join(appDataDir(), 'rules.json'), rules)
}

export function loadDeployProfiles(): DeployProfile[] {
  const profiles = readJsonFile<DeployProfile[]>(
    join(appDataDir(), 'deploy_profiles.json'),
    []
  )
  return Array.isArray(profiles)
    ? profiles.filter((profile) => profile && typeof profile.id === 'string')
    : []
}

export function saveDeployProfiles(profiles: DeployProfile[]): void {
  writeJsonFile(join(appDataDir(), 'deploy_profiles.json'), profiles)
}

export function loadKnownHosts(): KnownHostMap {
  return readJsonFile<KnownHostMap>(join(appDataDir(), 'known_hosts.json'), {})
}

export function saveKnownHosts(hosts: KnownHostMap): void {
  writeJsonFile(join(appDataDir(), 'known_hosts.json'), hosts)
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
