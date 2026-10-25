import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOOK_VERSION } from './deploy/settings'

function pythonVersion(file: string): string {
  const text = readFileSync(join(process.cwd(), 'resources', 'hooks', file), 'utf-8')
  const match = /^HOOK_VERSION = "([^"]+)"/m.exec(text)
  return match?.[1] || ''
}

describe('hook version sync', () => {
  it('keeps the TypeScript deployer and both Python hooks on one version', () => {
    expect(pythonVersion('claude_approval_hook.py')).toBe(HOOK_VERSION)
    expect(pythonVersion('claude_notify_hook.py')).toBe(HOOK_VERSION)
  })

  it('keeps the confirmation-prompt filter in both standalone hooks', () => {
    for (const file of ['claude_approval_hook.py', 'claude_notify_hook.py']) {
      const text = readFileSync(join(process.cwd(), 'resources', 'hooks', file), 'utf-8')
      expect(text, file).toContain('def _is_confirmation_prompt')
      expect(text, file).toContain('_CONFIRMATION_PROMPTS')
    }
  })
})
