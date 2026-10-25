import { describe, expect, it } from 'vitest'
import type { ApprovalRecord } from './types'
import {
  decisionCounts,
  formatWait,
  isConfirmationOnly,
  toolInputSummary,
  toolWording
} from './presentation'

function record(overrides: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: 'r1',
    ts: 1,
    sessionKey: '本机:s1',
    sessionLabel: 's1',
    origin: '本机',
    project: 'demo',
    tool: 'Bash',
    message: 'm',
    command: 'git status',
    decision: 'allow',
    source: 'popup',
    latencyMs: 1000,
    risk: 'low',
    ...overrides
  }
}

describe('toolWording', () => {
  it('describes common tools without repeating the raw tool name', () => {
    expect(toolWording('Bash')).toEqual({ content: '要执行', allow: '允许执行' })
    expect(toolWording('Edit')).toEqual({ content: '要修改文件', allow: '允许修改' })
    expect(toolWording('ExitPlanMode')).toEqual({ content: '计划', allow: '批准计划' })
  })

  it('handles MCP and unknown tools', () => {
    expect(toolWording('mcp__github__create_issue').allow).toBe('允许调用')
    expect(toolWording('SomeFutureTool')).toEqual({ content: '要执行操作', allow: '允许' })
  })
})

describe('toolInputSummary', () => {
  it('prefers description and prompt for Task-like tools', () => {
    expect(
      toolInputSummary({
        description: 'Audit retries',
        prompt: 'Read the payment retry loop\nand report the bug.',
        subagent_type: 'Explore'
      })
    ).toEqual(['Audit retries', 'Read the payment retry loop and report the bug.'])
  })

  it('falls back to scalar arguments and hides diff/plan payloads', () => {
    expect(toolInputSummary({ path: '/tmp/a', mode: 7, content: 'hidden' })).toEqual(['/tmp/a'])
    expect(toolInputSummary({ mode: 7, retries: 2 })).toEqual(['mode: 7', 'retries: 2'])
  })

  it('puts the search pattern before the path for Grep-like tools', () => {
    expect(toolInputSummary({ pattern: 'TODO', path: 'src' })).toEqual(['TODO', 'src'])
  })

  it('does not leak old/new strings from an edit payload', () => {
    expect(toolInputSummary({ old_string: 'secret old', new_string: 'secret new' })).toEqual([])
  })
})

describe('decisionCounts', () => {
  it('counts only matching allow and deny decisions for the same tool and command', () => {
    const history: ApprovalRecord[] = [
      record({ id: '1', decision: 'allow' }),
      record({ id: '2', decision: 'allow' }),
      record({ id: '3', decision: 'deny' }),
      record({ id: '4', decision: 'timeout' }),
      record({ id: '5', tool: 'Edit' }),
      record({ id: '6', command: 'git diff' })
    ]
    expect(decisionCounts(history, 'bash', ' git status ')).toEqual({ allow: 2, deny: 1 })
  })

  it('returns zeroes for an empty command', () => {
    expect(decisionCounts([record({})], 'Bash', '  ')).toEqual({ allow: 0, deny: 0 })
  })
})

describe('formatWait', () => {
  it('formats seconds, minutes and hours compactly', () => {
    expect(formatWait(0)).toBe('0s')
    expect(formatWait(12_400)).toBe('12s')
    expect(formatWait(60_000)).toBe('1m')
    expect(formatWait(220_000)).toBe('3m 40s')
    expect(formatWait(7_500_000)).toBe('2h 05m')
  })
})

describe('isConfirmationOnly', () => {
  it('recognizes bare confirmations so old hooks cannot title a task "继续"', () => {
    expect(isConfirmationOnly('继续')).toBe(true)
    expect(isConfirmationOnly('好的！')).toBe(true)
    expect(isConfirmationOnly(' OK ')).toBe(true)
    expect(isConfirmationOnly('继续修复登录重定向')).toBe(false)
    expect(isConfirmationOnly('修复登录')).toBe(false)
  })
})
