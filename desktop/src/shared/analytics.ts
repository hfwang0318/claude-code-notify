import type { ApprovalRecord, RiskLevel } from './types'

export interface HistoryAnalytics {
  total: number
  allowed: number
  denied: number
  timedOut: number
  terminal: number
  ruleHits: number
  p50LatencyMs: number
  p95LatencyMs: number
  topTools: Array<{ name: string; count: number }>
  highRisk: number
  byRisk: Record<RiskLevel, number>
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

export function summarizeHistory(records: ApprovalRecord[]): HistoryAnalytics {
  const latencies = records.map((record) => record.latencyMs).sort((a, b) => a - b)
  const tools = new Map<string, number>()
  const byRisk: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0 }
  let allowed = 0
  let denied = 0
  let timedOut = 0
  let terminal = 0
  let ruleHits = 0
  for (const record of records) {
    if (record.decision === 'allow') allowed += 1
    else if (record.decision === 'deny') denied += 1
    else if (record.decision === 'timeout') timedOut += 1
    else if (record.decision === 'cancelled') terminal += 1
    if (record.source === 'rule' || record.ruleId) ruleHits += 1
    tools.set(record.tool, (tools.get(record.tool) || 0) + 1)
    if (record.risk in byRisk) byRisk[record.risk] += 1
  }
  return {
    total: records.length,
    allowed,
    denied,
    timedOut,
    terminal,
    ruleHits,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    topTools: [...tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5),
    highRisk: byRisk.high,
    byRisk
  }
}

export function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

const FALLBACK_HANDLING_MS: Record<RiskLevel, number> = {
  low: 5000,
  medium: 8000,
  high: 12000
}

/**
 * How long this kind of decision usually takes *this user*. Derived from the
 * last 80 comparable history rows; falls back to a risk-based estimate when the
 * sample is too small (the first approvals of a fresh install).
 */
export function estimateHandlingMs(
  records: readonly ApprovalRecord[],
  tool: string,
  risk: RiskLevel
): number {
  const relevant = records
    .filter(
      (record) =>
        record.tool.toLowerCase() === tool.toLowerCase() &&
        (record.decision === 'allow' || record.decision === 'deny') &&
        record.latencyMs > 0
    )
    .slice(0, 80)
  const fallback = FALLBACK_HANDLING_MS[risk]
  if (relevant.length < 3) return fallback
  const sorted = relevant.map((record) => record.latencyMs).sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]
  const floor = risk === 'high' ? 8000 : risk === 'medium' ? 5000 : 2500
  return Math.min(45_000, Math.max(floor, median))
}
