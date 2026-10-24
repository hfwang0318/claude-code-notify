import { describe, expect, it } from 'vitest'
import type { ApprovalRecord } from './types'
import { formatLatency, summarizeHistory } from './analytics'

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

describe('history analytics', () => {
  it('counts decisions, rule hits, risk and top tools', () => {
    const summary = summarizeHistory([
      record({ id: '1', decision: 'allow', source: 'rule', risk: 'low', latencyMs: 10 }),
      record({ id: '2', decision: 'deny', tool: 'Edit', risk: 'medium', latencyMs: 20 }),
      record({ id: '3', decision: 'timeout', risk: 'high', latencyMs: 1000 }),
      record({ id: '4', decision: 'cancelled', risk: 'high', latencyMs: 40 })
    ])
    expect(summary.total).toBe(4)
    expect(summary.allowed).toBe(1)
    expect(summary.denied).toBe(1)
    expect(summary.timedOut).toBe(1)
    expect(summary.terminal).toBe(1)
    expect(summary.ruleHits).toBe(1)
    expect(summary.highRisk).toBe(2)
    expect(summary.topTools[0]).toEqual({ name: 'Bash', count: 3 })
    expect(summary.p50LatencyMs).toBe(20)
    expect(summary.p95LatencyMs).toBe(1000)
  })

  it('formats latencies for the UI', () => {
    expect(formatLatency(420)).toBe('420ms')
    expect(formatLatency(1600)).toBe('1.6s')
  })
})
