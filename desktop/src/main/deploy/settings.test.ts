import { describe, expect, it } from 'vitest'
import {
  buildEnvBlock,
  buildHookCommand,
  HOOK_PAUSE_BUDGET_SEC,
  mergeSettingsJson,
  type HookEntry
} from './settings'

const hook: HookEntry = {
  type: 'command',
  command: "CLAUDE_NOTIFY_TOKEN='abc' python3 $HOME/.claude/claude_approval_hook.py"
}

describe('mergeSettingsJson', () => {
  it('creates hooks for an empty settings file', () => {
    const merged = JSON.parse(
      mergeSettingsJson('', {
        mode: 'popup',
        hookEntry: hook,
        hookTimeout: 300,
        questionEntry: hook
      })
    )
    expect(merged.hooks.PermissionRequest).toHaveLength(1)
    expect(merged.hooks.PermissionRequest[0].hooks[0].timeout).toBe(
      300 + HOOK_PAUSE_BUDGET_SEC
    )
    expect(merged.hooks.PermissionRequest[0].matcher).toBe('')
    expect(merged.hooks.PreToolUse).toHaveLength(1)
    expect(merged.hooks.PreToolUse[0].hooks[0].timeout).toBe(300 + HOOK_PAUSE_BUDGET_SEC)
  })

  it('preserves third-party hooks and is idempotent', () => {
    const existing = JSON.stringify({
      hooks: {
        PermissionRequest: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo third-party' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'python3 ~/.claude/claude_approval_hook.py' }] }
        ],
        Notification: [
          { matcher: '', hooks: [{ type: 'command', command: 'python3 ~/.claude/claude_notify_hook.py' }] }
        ]
      },
      other: { keep: true }
    })

    const once = JSON.parse(
      mergeSettingsJson(existing, { mode: 'popup', hookEntry: hook, hookTimeout: 300 })
    )
    expect(once.other.keep).toBe(true)
    expect(once.hooks.PermissionRequest).toHaveLength(2)
    expect(once.hooks.Notification).toBeUndefined()

    const twice = JSON.parse(
      mergeSettingsJson(JSON.stringify(once), {
        mode: 'popup',
        hookEntry: hook,
        hookTimeout: 300
      })
    )
    expect(twice.hooks.PermissionRequest).toHaveLength(2)
  })

  it('installs a Stop hook for turn-completion notifications', () => {
    const notify: HookEntry = {
      type: 'command',
      command: "CLAUDE_NOTIFY_TOKEN='abc' python3 $HOME/.claude/claude_notify_hook.py"
    }
    const merged = JSON.parse(
      mergeSettingsJson('', {
        mode: 'popup',
        hookEntry: hook,
        hookTimeout: 300,
        stopEntry: notify
      })
    )
    expect(merged.hooks.Stop).toHaveLength(1)
    expect(merged.hooks.Stop[0].hooks[0].command).toContain('claude_notify_hook.py')
    expect(merged.hooks.Stop[0].hooks[0].timeout).toBe(30)
  })

  it('uses timeout 30 for notification mode', () => {
    const merged = JSON.parse(
      mergeSettingsJson('', { mode: 'notify', hookEntry: hook, hookTimeout: 300 })
    )
    expect(merged.hooks.Notification[0].hooks[0].timeout).toBe(30)
    expect(merged.hooks.PermissionRequest).toBeUndefined()
  })

  it('rejects invalid JSON and non-object roots', () => {
    expect(() =>
      mergeSettingsJson('{oops', { mode: 'popup', hookEntry: hook, hookTimeout: 300 })
    ).toThrow(/不是合法 JSON/)
    expect(() =>
      mergeSettingsJson('[]', { mode: 'popup', hookEntry: hook, hookTimeout: 300 })
    ).toThrow(/根节点必须是对象/)
  })
})

describe('buildHookCommand', () => {
  it('inlines env pairs and the script path', () => {
    const command = buildHookCommand(
      { CLAUDE_NOTIFY_TOKEN: 'abc', CLAUDE_APPROVAL_TIMEOUT: 240 },
      'claude_approval_hook.py'
    )
    expect(command).toBe(
      'CLAUDE_NOTIFY_TOKEN=\'abc\' CLAUDE_APPROVAL_TIMEOUT=\'240\' python3 "$HOME/.claude/claude_approval_hook.py"'
    )
  })

  it('escapes single quotes in env values', () => {
    const command = buildHookCommand({ CLAUDE_NOTIFY_ORIGIN: "a'b" }, 'claude_notify_hook.py')
    expect(command).toBe(
      "CLAUDE_NOTIFY_ORIGIN='a'\\''b' python3 \"$HOME/.claude/claude_notify_hook.py\""
    )
  })

  it('keeps spaces and dollar signs literal inside single-quoted values', () => {
    const command = buildHookCommand(
      {
        CLAUDE_NOTIFY_URL: 'http://host/a b',
        CLAUDE_NOTIFY_TOKEN: '$HOME/secret',
        CLAUDE_APPROVAL_MATCHER: 'Bash(git commit)'
      },
      'claude_approval_hook.py'
    )
    expect(command).toBe(
      "CLAUDE_NOTIFY_URL='http://host/a b' CLAUDE_NOTIFY_TOKEN='$HOME/secret' CLAUDE_APPROVAL_MATCHER='Bash(git commit)' python3 \"$HOME/.claude/claude_approval_hook.py\""
    )
    // The script path must stay in double quotes so the remote shell expands $HOME.
    expect(command.endsWith('python3 "$HOME/.claude/claude_approval_hook.py"')).toBe(true)
  })
})

describe('buildEnvBlock', () => {
  it.each([
    ['bash', "export CLAUDE_NOTIFY_TOKEN='t'"],
    ['zsh', "export CLAUDE_NOTIFY_TOKEN='t'"],
    ['csh', "setenv CLAUDE_NOTIFY_TOKEN 't'"],
    ['fish', "set -x CLAUDE_NOTIFY_TOKEN 't'"]
  ])('renders %s', (shell, line) => {
    const block = buildEnvBlock(shell, 't')
    expect(block).toContain('# >>> claude-notify >>>')
    expect(block).toContain(line)
    expect(block).toContain('# <<< claude-notify <<<')
  })
})

describe('stripSettingsJson', () => {
  it('removes only our hooks and preserves third-party entries', async () => {
    const { stripSettingsJson } = await import('./settings')
    const existing = JSON.stringify({
      hooks: {
        PermissionRequest: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo third-party' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'python3 ~/.claude/claude_approval_hook.py' }] }
        ],
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'python3 ~/.claude/claude_approval_hook.py' }] }
        ]
      },
      other: { keep: true }
    })
    const result = stripSettingsJson(existing)
    expect(result.removed).toBe(2)
    expect(result.changed).toBe(true)
    const parsed = JSON.parse(result.text)
    expect(parsed.other.keep).toBe(true)
    expect(parsed.hooks.PermissionRequest).toHaveLength(1)
    expect(parsed.hooks.PreToolUse).toBeUndefined()
  })
})

describe('installedHookVersion', () => {
  it('reads the version from the deployed config', async () => {
    const { installedHookVersion, HOOK_VERSION, HOOK_VERSION_KEY } = await import('./settings')
    expect(installedHookVersion({ [HOOK_VERSION_KEY]: HOOK_VERSION })).toBe(HOOK_VERSION)
    expect(installedHookVersion({ hook_version: '1' })).toBe('1')
    expect(installedHookVersion(null)).toBe('')
  })
})
