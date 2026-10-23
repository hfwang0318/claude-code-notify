export const APPROVAL_SCRIPT_NAME = 'claude_approval_hook.py'
export const NOTIFY_SCRIPT_NAME = 'claude_notify_hook.py'
export const HOOK_CONFIG_NAME = 'claude_notify_config.json'
export const ALL_HOOK_SCRIPTS = [APPROVAL_SCRIPT_NAME, NOTIFY_SCRIPT_NAME]
export const HOOK_VERSION = '7'
/** Extra time the hook process may stay alive while a popup countdown is paused. */
export const HOOK_PAUSE_BUDGET_SEC = 600
export const HOOK_VERSION_KEY = 'CLAUDE_NOTIFY_HOOK_VERSION'

export const ENV_MARK_BEGIN = '# >>> claude-notify >>>'
export const ENV_MARK_END = '# <<< claude-notify <<<'

export const SHELL_RC_FILES: Record<string, { label: string; rc: string }> = {
  bash: { label: 'Bash', rc: '.bashrc' },
  zsh: { label: 'Zsh', rc: '.zshrc' },
  csh: { label: 'Csh/Tcsh', rc: '.cshrc' },
  fish: { label: 'Fish', rc: '.config/fish/config.fish' }
}

export type DeployMode = 'popup' | 'notify'

export interface HookEntry {
  type: 'command'
  command: string
  args?: string[]
}

export interface MergeOptions {
  mode: DeployMode
  hookEntry: HookEntry
  hookTimeout: number
  matcher?: string
  questionEntry?: HookEntry
  stopEntry?: HookEntry
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildHookCommand(
  envPairs: Record<string, string | number>,
  scriptName: string
): string {
  const parts = Object.entries(envPairs).map(
    ([key, value]) => `${key}=${quoteShellValue(String(value))}`
  )
  // Double quotes keep the path safe while still allowing the remote shell to
  // expand $HOME. Single quotes would prevent expansion.
  parts.push(`python3 "$HOME/.claude/${scriptName}"`)
  return parts.join(' ')
}

function isOurHook(entry: unknown): boolean {
  try {
    const serialized = JSON.stringify(entry)
    return ALL_HOOK_SCRIPTS.some((script) => serialized.includes(script))
  } catch {
    return false
  }
}

interface CleanHookList {
  entries: unknown[]
  removed: number
}

/**
 * Remove our leaf hooks while keeping third-party hooks, even when a matcher
 * wrapper contains both. Older installs and hand-edited settings can mix them.
 */
function cleanHookList(entries: unknown[]): CleanHookList {
  const kept: unknown[] = []
  let removed = 0
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      kept.push(entry)
      continue
    }
    const record = entry as Record<string, unknown>
    if (Array.isArray(record.hooks)) {
      const nested = cleanHookList(record.hooks)
      if (nested.removed > 0) {
        removed += nested.removed
        if (nested.entries.length > 0) {
          kept.push({ ...record, hooks: nested.entries })
        }
      } else {
        kept.push(entry)
      }
      continue
    }
    if (isOurHook(entry)) {
      removed += 1
      continue
    }
    kept.push(entry)
  }
  return { entries: kept, removed }
}

/**
 * Walk every hook event (including sections added by newer Claude Code
 * versions), recursively remove only our entries, and drop empty containers.
 */
function cleanHooks(settings: Record<string, unknown>): number {
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : null
  if (!hooks) return 0
  let removed = 0
  for (const [sectionName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue
    const cleaned = cleanHookList(value)
    removed += cleaned.removed
    if (cleaned.removed === 0) continue
    if (cleaned.entries.length > 0) hooks[sectionName] = cleaned.entries
    else delete hooks[sectionName]
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks
  return removed
}

export function mergeSettingsJson(
  existingText: string,
  options: MergeOptions
): string {
  let settings: Record<string, unknown>
  try {
    settings = existingText.trim() ? JSON.parse(existingText) : {}
  } catch (error) {
    throw new Error(
      `服务器上现有 settings.json 不是合法 JSON：${(error as Error).message}`
    )
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('服务器上现有 settings.json 根节点必须是对象')
  }

  // Re-deploying should replace our hooks without dropping third-party hooks
  // that happen to share the same matcher wrapper.
  cleanHooks(settings)
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {}
  settings.hooks = hooks

  const entry: Record<string, unknown> = {
    ...options.hookEntry,
    timeout:
      options.mode === 'popup' ? options.hookTimeout + HOOK_PAUSE_BUDGET_SEC : 30
  }
  const sectionName = options.mode === 'popup' ? 'PermissionRequest' : 'Notification'
  const section = Array.isArray(hooks[sectionName])
    ? (hooks[sectionName] as unknown[])
    : []
  section.push({ matcher: options.matcher || '', hooks: [entry] })
  hooks[sectionName] = section

  if (options.stopEntry) {
    const stopSection = Array.isArray(hooks.Stop)
      ? (hooks.Stop as unknown[])
      : []
    stopSection.push({
      matcher: '',
      hooks: [{ ...options.stopEntry, timeout: 30 }]
    })
    hooks.Stop = stopSection
  }

  if (options.mode === 'popup' && options.questionEntry) {
    const questionEntry: Record<string, unknown> = {
      ...options.questionEntry,
      timeout: options.hookTimeout + HOOK_PAUSE_BUDGET_SEC
    }
    const preSection = Array.isArray(hooks.PreToolUse)
      ? (hooks.PreToolUse as unknown[])
      : []
    preSection.push({ matcher: '', hooks: [questionEntry] })
    hooks.PreToolUse = preSection
  }

  return `${JSON.stringify(settings, null, 2)}\n`
}

export function settingsHaveOurHooks(existingText: string): boolean {
  if (!existingText.trim()) return false
  return ALL_HOOK_SCRIPTS.some((script) => existingText.includes(script))
}

export function stripSettingsJson(existingText: string): {
  text: string
  removed: number
  changed: boolean
} {
  if (!existingText.trim()) return { text: '', removed: 0, changed: false }
  const settings = JSON.parse(existingText) as Record<string, unknown>
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('settings.json 根节点必须是对象')
  }
  const removed = cleanHooks(settings)
  if (removed === 0) {
    // Preserve the original formatting when there is nothing of ours to remove.
    return { text: existingText, removed: 0, changed: false }
  }
  return { text: `${JSON.stringify(settings, null, 2)}\n`, removed, changed: true }
}

export function installedHookVersion(config: Record<string, unknown> | null): string {
  if (!config) return ''
  const value = config[HOOK_VERSION_KEY] || config.hook_version
  return typeof value === 'string' ? value : ''
}

export function buildEnvBlock(shell: string, token: string): string {
  let line: string
  if (shell === 'csh') line = `setenv CLAUDE_NOTIFY_TOKEN '${token}'`
  else if (shell === 'fish') line = `set -x CLAUDE_NOTIFY_TOKEN '${token}'`
  else line = `export CLAUDE_NOTIFY_TOKEN='${token}'`
  return `${ENV_MARK_BEGIN}\n${line}\n${ENV_MARK_END}`
}

export function removeEnvBlock(content: string): string {
  const escape = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return content
    .replace(
      new RegExp(`\\n?${escape(ENV_MARK_BEGIN)}[\\s\\S]*?${escape(ENV_MARK_END)}\\n?`, 'g'),
      '\n'
    )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
}
