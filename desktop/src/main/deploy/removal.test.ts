import { describe, expect, it } from 'vitest'
import { mergeSettingsJson, stripSettingsJson, type HookEntry } from './settings'

const approval: HookEntry = {
  type: 'command',
  command: 'C:\\Python313\\python.exe',
  args: ['C:\\Users\\me\\.claude\\claude_approval_hook.py']
}
const notify: HookEntry = {
  type: 'command',
  command: 'C:\\Python313\\python.exe',
  args: ['C:\\Users\\me\\.claude\\claude_notify_hook.py']
}

describe('uninstall settings cleanup', () => {
  it('removes windows exec-form hooks from every section', () => {
    const merged = mergeSettingsJson('', {
      mode: 'popup',
      hookEntry: approval,
      hookTimeout: 300,
      questionEntry: approval,
      stopEntry: notify
    })
    expect(merged).toContain('claude_approval_hook.py')
    const stripped = stripSettingsJson(merged)
    expect(stripped.removed).toBe(3)
    expect(stripped.changed).toBe(true)
    expect(stripped.text).not.toContain('claude_approval_hook.py')
    expect(stripped.text).not.toContain('claude_notify_hook.py')
  })

  it('removes posix shell-form hooks from every section', () => {
    const merged = mergeSettingsJson('', {
      mode: 'popup',
      hookEntry: {
        type: 'command',
        command: "CLAUDE_NOTIFY_TOKEN='t' python3 \"$HOME/.claude/claude_approval_hook.py\""
      },
      hookTimeout: 300,
      questionEntry: {
        type: 'command',
        command: "CLAUDE_NOTIFY_TOKEN='t' python3 \"$HOME/.claude/claude_approval_hook.py\""
      },
      stopEntry: {
        type: 'command',
        command: "CLAUDE_NOTIFY_TOKEN='t' python3 \"$HOME/.claude/claude_notify_hook.py\""
      }
    })
    const stripped = stripSettingsJson(merged)
    expect(stripped.removed).toBe(3)
    expect(stripped.text).not.toContain('claude_approval_hook.py')
    expect(stripped.text).not.toContain('claude_notify_hook.py')
  })

  it('removes our hooks from sections added after this app version', () => {
    const existing = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: '', hooks: [approval] }],
        UserPromptSubmit: [{ matcher: '', hooks: [notify] }]
      },
      other: { keep: true }
    })
    const stripped = stripSettingsJson(existing)
    expect(stripped.removed).toBe(2)
    expect(stripped.text).not.toContain('claude_approval_hook.py')
    expect(stripped.text).not.toContain('claude_notify_hook.py')
    expect(JSON.parse(stripped.text).other.keep).toBe(true)
  })

  it('keeps third-party hooks that share a wrapper with ours', () => {
    const existing = JSON.stringify({
      hooks: {
        PermissionRequest: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'echo third-party' },
              approval
            ]
          }
        ]
      }
    })
    const stripped = stripSettingsJson(existing)
    expect(stripped.removed).toBe(1)
    const parsed = JSON.parse(stripped.text)
    expect(parsed.hooks.PermissionRequest).toHaveLength(1)
    expect(parsed.hooks.PermissionRequest[0].hooks).toHaveLength(1)
    expect(parsed.hooks.PermissionRequest[0].hooks[0].command).toBe('echo third-party')
  })

  it('drops an empty hooks object after the last hook is removed', () => {
    const existing = JSON.stringify({
      hooks: { PermissionRequest: [{ matcher: '', hooks: [approval] }] }
    })
    const stripped = stripSettingsJson(existing)
    expect(stripped.removed).toBe(1)
    expect(JSON.parse(stripped.text).hooks).toBeUndefined()
  })
})
