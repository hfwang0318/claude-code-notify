import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LogLevel } from '../../shared/types'
import {
  APPROVAL_SCRIPT_NAME,
  HOOK_CONFIG_NAME,
  HOOK_VERSION,
  HOOK_VERSION_KEY,
  NOTIFY_SCRIPT_NAME,
  SHELL_RC_FILES,
  buildEnvBlock,
  installedHookVersion,
  mergeSettingsJson,
  removeEnvBlock,
  stripSettingsJson,
  type DeployMode,
  type HookEntry
} from './settings'
import { hooksDirectory, localClaudeDir, quoteShell, timestamp } from './paths'

export interface LocalDeployConfig {
  mode: DeployMode
  token: string
  port: number
  timeoutSec?: number
  writeEnv: boolean
  envShells: string[]
  origin?: string
  claudeDir?: string
  hooksDir?: string
  pythonPath?: string
}

export interface LocalDeployResult {
  mode: DeployMode
  settingsPath: string
  scriptPath: string
  configPath: string
  hookEntry: HookEntry
}

type Platform = 'win32' | 'darwin' | 'linux'

export function buildLocalHookEntry(
  envPairs: Record<string, string | number>,
  scriptPath: string,
  platform: Platform,
  pythonPath?: string
): HookEntry {
  if (platform === 'win32') {
    if (!pythonPath) throw new Error('Windows 本机接入需要 python 解释器绝对路径')
    return { type: 'command', command: pythonPath, args: [scriptPath] }
  }
  const parts = Object.entries(envPairs).map(
    ([key, value]) => `${key}=${quoteShell(String(value))}`
  )
  parts.push(`python3 ${quoteShell(scriptPath)}`)
  return { type: 'command', command: parts.join(' ') }
}

function pythonCandidates(): string[][] {
  const candidates: string[][] = [
    ['py', '-3'],
    ['python'],
    ['python3']
  ]
  const roots = [
    process.env.LOCALAPPDATA || '',
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || ''
  ].filter(Boolean)
  for (const root of roots) {
    const programs = join(root, 'Programs', 'Python')
    try {
      for (const entry of readdirSync(programs)) {
        if (!entry.toLowerCase().startsWith('python')) continue
        const executable = join(programs, entry, 'python.exe')
        if (existsSync(executable)) candidates.push([executable])
      }
    } catch {
      // ignore missing directories
    }
  }
  try {
    for (const entry of readdirSync('C:\\')) {
      if (!entry.toLowerCase().startsWith('python')) continue
      const executable = join('C:\\', entry, 'python.exe')
      if (existsSync(executable)) candidates.push([executable])
    }
  } catch {
    // ignore inaccessible root
  }
  return candidates
}

export function resolveWindowsPython(): string {
  for (const command of pythonCandidates()) {
    try {
      const result = spawnSync(command[0], [...command.slice(1), '-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true
      })
      if (result.status !== 0) continue
      const resolved = (result.stdout || '').trim().split(/\r?\n/)[0]
      if (resolved && existsSync(resolved)) return resolved
    } catch {
      // try next candidate
    }
  }
  throw new Error('未找到可用的 Python 解释器（已尝试 py / python / python3 与常见安装目录）')
}

export function detectLocalDeploy(claudeDir = localClaudeDir()): DeployMode | null {
  const settingsPath = join(claudeDir, 'settings.json')
  if (!existsSync(settingsPath)) return null
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: Record<string, unknown>
    }
    const serialized = JSON.stringify(settings.hooks || {})
    if (serialized.includes(APPROVAL_SCRIPT_NAME)) return 'popup'
    if (serialized.includes(NOTIFY_SCRIPT_NAME)) return 'notify'
  } catch {
    return null
  }
  return null
}

function ensureDir(directory: string): void {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows does not support POSIX modes
  }
}

export function deployLocal(
  config: LocalDeployConfig,
  onProgress: (level: LogLevel, message: string) => void
): LocalDeployResult {
  const platform = process.platform as Platform
  const claudeDir = config.claudeDir || localClaudeDir()
  const scriptsDir = config.hooksDir || hooksDirectory()
  ensureDir(claudeDir)
  try {
    chmodSync(claudeDir, 0o700)
  } catch {
    // Windows
  }

  const isPopup = config.mode === 'popup'
  const scriptName = isPopup ? APPROVAL_SCRIPT_NAME : NOTIFY_SCRIPT_NAME
  const source = join(scriptsDir, scriptName)
  if (!existsSync(source)) throw new Error(`找不到内置钩子脚本 ${source}`)

  const scriptPath = join(claudeDir, scriptName)
  writeFileSync(scriptPath, readFileSync(source, 'utf-8'), 'utf-8')
  try {
    chmodSync(scriptPath, 0o755)
  } catch {
    // Windows
  }
  const notifySource = join(scriptsDir, NOTIFY_SCRIPT_NAME)
  const notifyScriptPath = join(claudeDir, NOTIFY_SCRIPT_NAME)
  if (isPopup) {
    if (!existsSync(notifySource)) throw new Error(`找不到内置钩子脚本 ${notifySource}`)
    writeFileSync(notifyScriptPath, readFileSync(notifySource, 'utf-8'), 'utf-8')
    try {
      chmodSync(notifyScriptPath, 0o755)
    } catch {
      // Windows
    }
  }
  if (!isPopup && existsSync(join(claudeDir, APPROVAL_SCRIPT_NAME))) {
    unlinkSync(join(claudeDir, APPROVAL_SCRIPT_NAME))
  }
  onProgress('info', `本机钩子脚本已写入 ${scriptPath}`)

  const settingsPath = join(claudeDir, 'settings.json')
  let existing = ''
  if (existsSync(settingsPath) && statSync(settingsPath).isFile()) {
    existing = readFileSync(settingsPath, 'utf-8')
    const backupPath = `${settingsPath}.bak.${timestamp()}`
    writeFileSync(backupPath, existing, 'utf-8')
    onProgress('info', `已备份本机配置 → ${backupPath}`)
  }

  const baseUrl = `http://127.0.0.1:${config.port}`
  const envPairs: Record<string, string | number> =
    config.mode === 'popup'
      ? {
          CLAUDE_NOTIFY_TOKEN: config.token,
          CLAUDE_APPROVAL_URL: `${baseUrl}/claude-approval`,
          CLAUDE_NOTIFY_URL: `${baseUrl}/claude-notify`,
          CLAUDE_APPROVAL_TIMEOUT: config.timeoutSec ?? 240,
          CLAUDE_ASKUSER_CHANNEL: 'pretooluse',
          CLAUDE_NOTIFY_ORIGIN: config.origin || '本机',
          [HOOK_VERSION_KEY]: HOOK_VERSION
        }
      : {
          CLAUDE_NOTIFY_TOKEN: config.token,
          CLAUDE_NOTIFY_URL: `${baseUrl}/claude-notify`,
          CLAUDE_NOTIFY_ORIGIN: config.origin || '本机',
          [HOOK_VERSION_KEY]: HOOK_VERSION
        }

  const pythonPath =
    platform === 'win32' ? config.pythonPath || resolveWindowsPython() : undefined
  const hookEntry = buildLocalHookEntry(envPairs, scriptPath, platform, pythonPath)
  const notifyEnvPairs: Record<string, string | number> = {
    CLAUDE_NOTIFY_TOKEN: config.token,
    CLAUDE_NOTIFY_URL: `${baseUrl}/claude-notify`,
    CLAUDE_NOTIFY_ORIGIN: config.origin || '本机',
    [HOOK_VERSION_KEY]: HOOK_VERSION
  }
  const stopEntry = isPopup
    ? buildLocalHookEntry(notifyEnvPairs, notifyScriptPath, platform, pythonPath)
    : hookEntry
  const merged = mergeSettingsJson(existing, {
    mode: config.mode,
    hookEntry,
    hookTimeout: 300,
    questionEntry: hookEntry,
    stopEntry
  })
  writeFileSync(settingsPath, merged, 'utf-8')
  onProgress(
    'notify',
    `本机 settings.json 已合并（${config.mode === 'popup' ? '置顶弹窗' : '系统通知'}）`
  )
  if (pythonPath) onProgress('info', `钩子解释器：${pythonPath}（绝对路径，exec form）`)

  const configPath = join(claudeDir, HOOK_CONFIG_NAME)
  writePrivate(configPath, `${JSON.stringify(envPairs, null, 2)}\n`)
  onProgress('info', `钩子配置已写入 ${configPath}`)

  const verifyPython = platform === 'win32' ? hookEntry.command : 'python3'
  const verify = spawnSync(verifyPython, ['-m', 'py_compile', scriptPath], {
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true
  })
  if (verify.status !== 0) {
    throw new Error(
      `钩子脚本编译验证失败 exit=${verify.status}: ${(verify.stderr || '').slice(0, 200)}`
    )
  }
  onProgress('info', '钩子脚本编译验证通过')

  if (config.writeEnv) {
    if (platform === 'win32') {
      const result = spawnSync('setx', ['CLAUDE_NOTIFY_TOKEN', config.token], {
        encoding: 'utf-8',
        windowsHide: true
      })
      if (result.status === 0) {
        onProgress('info', '已用 setx 写入用户环境变量 CLAUDE_NOTIFY_TOKEN')
      } else {
        onProgress('warn', 'setx 写入环境变量失败，钩子仍可通过配置文件读取 Token')
      }
    } else {
      for (const shell of config.envShells) {
        const info = SHELL_RC_FILES[shell]
        if (!info) continue
        const rcPath = join(homedir(), info.rc)
        ensureDir(dirname(rcPath))
        const current = existsSync(rcPath) ? readFileSync(rcPath, 'utf-8') : ''
        const cleaned = removeEnvBlock(current)
        const block = buildEnvBlock(shell, config.token)
        writeFileSync(rcPath, cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`, 'utf-8')
        onProgress('info', `已写入 ${info.label} 环境变量 → ${rcPath}`)
      }
    }
  }

  onProgress('notify', '本机接入完成 ✓ 钩子读取配置文件，无需重启 Claude Code 即可生效')
  return { mode: config.mode, settingsPath, scriptPath, configPath, hookEntry }
}

export interface LocalInstallState {
  mode: DeployMode | null
  version: string
  stale: boolean
  configPath: string
  settingsPath: string
  latestBackup: string | null
}

function latestBackup(settingsPath: string): string | null {
  const directory = dirname(settingsPath)
  if (!existsSync(directory)) return null
  try {
    const backups = readdirSync(directory)
      .filter((name) => name.startsWith('settings.json.bak.'))
      .sort()
      .reverse()
    return backups.length > 0 ? join(directory, backups[0]) : null
  } catch {
    return null
  }
}

export function detectLocalState(claudeDir = localClaudeDir()): LocalInstallState {
  const settingsPath = join(claudeDir, 'settings.json')
  const configPath = join(claudeDir, HOOK_CONFIG_NAME)
  const mode = detectLocalDeploy(claudeDir)
  let config: Record<string, unknown> | null = null
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    }
  } catch {
    config = null
  }
  const version = installedHookVersion(config)
  return {
    mode,
    version,
    stale: Boolean(mode) && version !== HOOK_VERSION,
    configPath,
    settingsPath,
    latestBackup: latestBackup(settingsPath)
  }
}

export interface LocalRemoveResult {
  ok: boolean
  removedHooks: number
  backupPath: string
  settingsPath: string
  removedScripts: number
}

export function removeLocalDeploy(
  config: {
    claudeDir?: string
    writeEnv?: boolean
    envShells?: string[]
  } = {},
  onProgress: (level: LogLevel, message: string) => void = () => undefined
): LocalRemoveResult {
  const claudeDir = config.claudeDir || localClaudeDir()
  const settingsPath = join(claudeDir, 'settings.json')
  let removedHooks = 0
  let backupPath = ''
  if (existsSync(settingsPath)) {
    const existing = readFileSync(settingsPath, 'utf-8')
    backupPath = `${settingsPath}.bak.${timestamp()}`
    writeFileSync(backupPath, existing, 'utf-8')
    const stripped = stripSettingsJson(existing)
    removedHooks = stripped.removed
    if (stripped.changed) {
      writeFileSync(settingsPath, stripped.text, 'utf-8')
      onProgress('info', `已从本机 settings.json 移除 ${removedHooks} 个钩子条目`)
    }
  }
  let removedScripts = 0
  for (const script of [APPROVAL_SCRIPT_NAME, NOTIFY_SCRIPT_NAME, HOOK_CONFIG_NAME]) {
    const path = join(claudeDir, script)
    if (existsSync(path)) {
      unlinkSync(path)
      removedScripts += 1
    }
  }
  onProgress('info', `已删除本机钩子文件 ${removedScripts} 个`)
  if (config.writeEnv && config.envShells) {
    for (const shell of config.envShells) {
      const info = SHELL_RC_FILES[shell]
      if (!info) continue
      const rcPath = join(homedir(), info.rc)
      if (!existsSync(rcPath)) continue
      const current = readFileSync(rcPath, 'utf-8')
      const cleaned = removeEnvBlock(current)
      if (cleaned !== current) {
        writeFileSync(rcPath, `${cleaned}\n`, 'utf-8')
        onProgress('info', `已从 ${info.label} 配置移除 Token 环境变量`)
      }
    }
  }
  onProgress('notify', '本机接入已断开，Claude Code 将回到终端审批')
  return { ok: true, removedHooks, backupPath, settingsPath, removedScripts }
}

export function restoreLocalBackup(
  claudeDir = localClaudeDir(),
  onProgress: (level: LogLevel, message: string) => void = () => undefined
): { ok: boolean; restoredFrom: string; backupOfCurrent: string } {
  const settingsPath = join(claudeDir, 'settings.json')
  const backup = latestBackup(settingsPath)
  if (!backup) throw new Error('没有找到可恢复的 settings.json 备份')
  const backupOfCurrent = existsSync(settingsPath)
    ? `${settingsPath}.pre-restore.${timestamp()}`
    : ''
  if (backupOfCurrent) {
    writeFileSync(backupOfCurrent, readFileSync(settingsPath, 'utf-8'), 'utf-8')
  }
  writeFileSync(settingsPath, readFileSync(backup, 'utf-8'), 'utf-8')
  onProgress('notify', `已恢复 settings.json ← ${backup}`)
  return { ok: true, restoredFrom: backup, backupOfCurrent }
}
