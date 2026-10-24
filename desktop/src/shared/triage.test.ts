import { describe, expect, it } from 'vitest'
import type { ApprovalItem } from './types'
import { diffStat, slackSeconds, sortForTriage, URGENT_SECONDS } from './session'
import { estimateHandlingMs } from './analytics'
import type { ApprovalRecord } from './types'

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

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'r',
    ts: 1,
    sessionKey: '本机:s',
    sessionLabel: 'app',
    origin: '本机',
    project: 'app',
    tool: 'Bash',
    message: '',
    command: 'git status',
    decision: 'allow',
    source: 'popup',
    latencyMs: 100,
    risk: 'low',
    ...overrides
  }
}

describe('session-aware EDF', () => {
  it('interleaves sessions whose deadlines are close', () => {
    const ordered = sortForTriage([
      item({ id: 'a1', sessionKey: '本机:a', timeoutAt: 100_000 }),
      item({ id: 'a2', sessionKey: '本机:a', timeoutAt: 101_000 }),
      item({ id: 'a3', sessionKey: '本机:a', timeoutAt: 102_000 }),
      item({ id: 'b1', sessionKey: '本机:b', timeoutAt: 105_000 })
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['a1', 'b1', 'a2', 'a3'])
  })

  it('keeps pure deadline order when another session is far away', () => {
    const ordered = sortForTriage([
      item({ id: 'a1', sessionKey: '本机:a', timeoutAt: 100_000 }),
      item({ id: 'a2', sessionKey: '本机:a', timeoutAt: 101_000 }),
      item({ id: 'b1', sessionKey: '本机:b', timeoutAt: 120_000 })
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['a1', 'a2', 'b1'])
  })

  it('never drops or duplicates an item', () => {
    const items = [
      item({ id: 'a1', sessionKey: '本机:a', timeoutAt: 100_000 }),
      item({ id: 'b1', sessionKey: '本机:b', timeoutAt: 100_500 }),
      item({ id: 'c1', sessionKey: '本机:c', timeoutAt: 101_000 }),
      item({ id: 'a2', sessionKey: '本机:a', timeoutAt: 102_000 })
    ]
    const ordered = sortForTriage(items)
    expect(ordered).toHaveLength(items.length)
    expect(new Set(ordered.map((entry) => entry.id))).toEqual(
      new Set(items.map((entry) => entry.id))
    )
  })

  it('exposes a single urgency threshold', () => {
    expect(URGENT_SECONDS).toBe(20)
  })
})

describe('slack and diff summaries', () => {
  it('turns remaining time plus an estimate into a margin', () => {
    expect(slackSeconds(42, 8_000)).toBe(34)
    expect(slackSeconds(4, 12_000)).toBe(-8)
  })

  it('summarises additions, deletions and files', () => {
    expect(
      diffStat([
        { filePath: 'a.ts', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' },
        { filePath: 'b.ts', oldText: '', newText: 'x' }
      ])
    ).toEqual({ files: 2, additions: 4, deletions: 2 })
  })
})

describe('handling estimate', () => {
  it('uses the median of comparable history once there are enough samples', () => {
    const records = [
      record({ id: '1', latencyMs: 3_000 }),
      record({ id: '2', latencyMs: 5_000 }),
      record({ id: '3', latencyMs: 7_000 })
    ]
    expect(estimateHandlingMs(records, 'Bash', 'low')).toBe(5_000)
  })

  it('keeps a floor for risky decisions even when history is fast', () => {
    const records = [
      record({ id: '1', latencyMs: 1_000, risk: 'high' }),
      record({ id: '2', latencyMs: 1_200, risk: 'high' }),
      record({ id: '3', latencyMs: 1_400, risk: 'high' })
    ]
    expect(estimateHandlingMs(records, 'Bash', 'high')).toBe(8_000)
  })

  it('falls back to a risk-based estimate without enough samples', () => {
    expect(estimateHandlingMs([], 'Bash', 'low')).toBe(5_000)
    expect(estimateHandlingMs([], 'Bash', 'medium')).toBe(8_000)
    expect(estimateHandlingMs([], 'Bash', 'high')).toBe(12_000)
  })
})
