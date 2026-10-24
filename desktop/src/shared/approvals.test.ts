import { describe, expect, it } from 'vitest'
import type { ApprovalItem } from './types'
import {
  admissionSnapshot,
  approvalClusterKey,
  clusterApprovals,
  clusterFor,
  crossSessionClusters,
  stableStringify
} from './approvals'

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

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}'
    )
  })
})

describe('approval clustering', () => {
  it('groups identical permission requests in the same session', () => {
    const clusters = clusterApprovals([
      item({ id: 'a', toolInput: { command: 'git status', cwd: '/w' } }),
      item({ id: 'b', toolInput: { cwd: '/w', command: 'git status' } }),
      item({ id: 'c', toolInput: { command: 'git diff' } })
    ])
    expect(clusters).toHaveLength(2)
    expect(clusters[0].items.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(clusters[0].representative.id).toBe('a')
    expect(clusterFor(clusters, 'b').map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('does not merge across sessions, tools or questions', () => {
    const clusters = clusterApprovals([
      item({ id: 'a', sessionKey: '本机:s1' }),
      item({ id: 'b', sessionKey: '本机:s2' }),
      item({ id: 'c', tool: 'Edit' }),
      item({ id: 'd', kind: 'question', questions: [] }),
      item({ id: 'e', kind: 'question', questions: [] })
    ])
    expect(clusters).toHaveLength(5)
    expect(approvalClusterKey(item({ id: 'a' }))).not.toBe(
      approvalClusterKey(item({ id: 'b', sessionKey: '本机:s2' }))
    )
  })
})

describe('cross-session duplicate visibility', () => {
  it('groups the same tool input across sessions but never questions', () => {
    const groups = crossSessionClusters([
      item({ id: 'a', sessionKey: '本机:s1', toolInput: { command: 'pnpm test' } }),
      item({ id: 'b', sessionKey: '本机:s2', toolInput: { command: 'pnpm test' } }),
      item({ id: 'c', sessionKey: '本机:s3', toolInput: { command: 'git status' } }),
      item({ id: 'q1', kind: 'question' }),
      item({ id: 'q2', kind: 'question', sessionKey: '本机:s2' })
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(groups[1].items.map((entry) => entry.id)).toEqual(['c'])
  })
})

describe('admission snapshot', () => {
  it('counts decision groups instead of raw requests', () => {
    const now = 1_000_000
    const snapshot = admissionSnapshot(
      [
        item({ id: 'a', timeoutAt: now + 30_000 }),
        item({ id: 'b', timeoutAt: now + 30_000 }),
        item({ id: 'c', sessionKey: '本机:s2', timeoutAt: now + 30_000 })
      ],
      now
    )
    expect(snapshot.active).toBe(3)
    expect(snapshot.clusters).toBe(2)
    expect(snapshot.estimateSec).toBe(36)
  })

  it('ignores snoozed requests and paused timers for the estimate', () => {
    const now = 1_000_000
    const snapshot = admissionSnapshot(
      [
        item({ id: 'a', timeoutAt: now + 30_000 }),
        item({ id: 'b', sessionKey: '本机:s2', paused: true, timeoutAt: Number.MAX_SAFE_INTEGER }),
        item({
          id: 'c',
          sessionKey: '本机:s3',
          snoozedUntil: now + 60_000,
          timeoutAt: now + 30_000
        })
      ],
      now
    )
    expect(snapshot.active).toBe(2)
    expect(snapshot.clusters).toBe(2)
    expect(snapshot.timedClusters).toBe(1)
    expect(snapshot.estimateSec).toBe(18)
  })
})
