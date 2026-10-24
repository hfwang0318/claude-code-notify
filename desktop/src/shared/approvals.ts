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
