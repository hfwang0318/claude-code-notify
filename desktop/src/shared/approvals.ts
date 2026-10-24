import type { ApprovalItem } from './types'

/** Stable JSON so two identical tool inputs always produce the same group key. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

export interface ApprovalCluster {
  key: string
  /** Oldest / primary request; the card shows this one. */
  representative: ApprovalItem
  /** Every pending request that would receive the same decision. */
  items: ApprovalItem[]
}

/**
 * Identical requests are common when several tools run in parallel. Group only
 * permission requests with the same session, tool and canonical input; a
 * question is always its own cluster because answers are not interchangeable.
 */
export function approvalClusterKey(item: ApprovalItem): string {
  if (item.kind === 'question') return `${item.sessionKey}\u0000question\u0000${item.id}`
  return `${item.sessionKey}\u0000${item.tool}\u0000${stableStringify(item.toolInput)}`
}

export function clusterApprovals(items: ApprovalItem[]): ApprovalCluster[] {
  const clusters = new Map<string, ApprovalCluster>()
  for (const item of items) {
    const key = approvalClusterKey(item)
    const existing = clusters.get(key)
    if (existing) existing.items.push(item)
    else clusters.set(key, { key, representative: item, items: [item] })
  }
  return [...clusters.values()]
}

/** The cluster that contains `id`, or an empty list when it already resolved. */
export function clusterFor(clusters: ApprovalCluster[], id: string): ApprovalItem[] {
  return clusters.find((cluster) => cluster.items.some((item) => item.id === id))?.items || []
}

/**
 * Same tool + same canonical input, ignoring the session. This is only used to
 * *surface* parallel work (three worktrees asking for the same test command);
 * a decision is never applied across sessions without an explicit confirmation.
 */
export function crossSessionKey(item: ApprovalItem): string | null {
  if (item.kind === 'question') return null
  return `${item.tool}\u0000${stableStringify(item.toolInput)}`
}

export interface CrossSessionCluster {
  key: string
  items: ApprovalItem[]
}

export function crossSessionClusters(items: ApprovalItem[]): CrossSessionCluster[] {
  const clusters = new Map<string, CrossSessionCluster>()
  for (const item of items) {
    const key = crossSessionKey(item)
    if (!key) continue
    const existing = clusters.get(key)
    if (existing) existing.items.push(item)
    else clusters.set(key, { key, items: [item] })
  }
  return [...clusters.values()]
}

/** Estimated wall-clock cost of one decision, used by the admission heuristic. */
export const SECONDS_PER_DECISION = 18

export interface AdmissionSnapshot {
  /** Requests that are visible right now (not snoozed). */
  active: number
  /** Distinct decisions waiting, regardless of pause state. */
  clusters: number
  /** Distinct decisions whose hook timer is still running. */
  timedClusters: number
  estimateSec: number
}

/**
 * Identical requests share one card and one decision, so counting raw HTTP
 * requests overstates the queue by a lot. Admission must count decision groups.
 */
export function admissionSnapshot(items: ApprovalItem[], now = Date.now()): AdmissionSnapshot {
  const active = items.filter((item) => !item.snoozedUntil || item.snoozedUntil <= now)
  const clusters = new Set(active.map(approvalClusterKey))
  const timed = new Set(active.filter((item) => !item.paused).map(approvalClusterKey))
  return {
    active: active.length,
    clusters: clusters.size,
    timedClusters: timed.size,
    estimateSec: timed.size * SECONDS_PER_DECISION
  }
}
