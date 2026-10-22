import { useMemo, useState } from 'react'
import type { ApprovalRecord } from '../../shared/types'
import { DECISION_LABEL, RISK_LABEL, SOURCE_LABEL, formatDateTime, formatRelative } from './format'
import { sessionColor } from '../../shared/session'
import { api } from './api'

interface Props {
  history: ApprovalRecord[]
  now: number
  onOpenInbox: () => void
}

const DECISION_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'allow', label: '允许' },
  { id: 'deny', label: '拒绝' },
  { id: 'timeout', label: '超时' },
  { id: 'cancelled', label: '终端' },
  { id: 'answer', label: '回答' }
]

const RISK_FILTERS = [
  { id: 'all', label: '全部风险' },
  { id: 'high', label: RISK_LABEL.high },
  { id: 'medium', label: RISK_LABEL.medium },
  { id: 'low', label: RISK_LABEL.low }
]

const SOURCE_FILTERS = [
  { id: 'all', label: '全部来源' },
  ...Object.entries(SOURCE_LABEL).map(([id, label]) => ({ id, label }))
]

const TIME_FILTERS = [
  { id: 'all', label: '全部时间' },
  { id: '24h', label: '最近 24 小时' },
  { id: '7d', label: '最近 7 天' }
]

const DAY_MS = 24 * 60 * 60 * 1000

export default function HistoryPanel({ history, now, onOpenInbox }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [decision, setDecision] = useState('all')
  const [risk, setRisk] = useState('all')
  const [source, setSource] = useState('all')
  const [timeRange, setTimeRange] = useState('all')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    const minTs =
      timeRange === '24h' ? now - DAY_MS : timeRange === '7d' ? now - 7 * DAY_MS : null
    return history.filter((record) => {
      if (decision !== 'all' && record.decision !== decision) return false
      if (risk !== 'all' && record.risk !== risk) return false
      if (source !== 'all' && record.source !== source) return false
      if (minTs !== null && record.ts < minTs) return false
      if (!text) return true
      return [
        record.sessionLabel,
        record.origin,
        record.project,
        record.tool,
        record.command,
        record.decision,
        record.source
      ]
        .join(' ')
        .toLowerCase()
        .includes(text)
    })
  }, [decision, history, now, query, risk, source, timeRange])

  const exportCsv = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    const result = await api.historyExport()
    setBusy(false)
    setMessage(result.message)
  }

  return (
    <div className="history">
      <div className="panel-toolbar">
        <input
          className="search-input"
          value={query}
          placeholder="搜索会话、项目、工具或命令…"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索审批历史"
        />
        <div className="filter-chips" role="group" aria-label="结果筛选">
          {DECISION_FILTERS.map((filter) => (
            <button
              key={filter.id}
              className={decision === filter.id ? 'chip active' : 'chip'}
              aria-pressed={decision === filter.id}
              onClick={() => setDecision(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="filter-chips" role="group" aria-label="风险、来源与时间筛选">
          <select
            className="ip-select"
            style={{ width: 'auto', flex: 'none' }}
            value={risk}
            onChange={(event) => setRisk(event.target.value)}
            aria-label="按风险筛选"
            title="按风险筛选"
          >
            {RISK_FILTERS.map((filter) => (
              <option key={filter.id} value={filter.id}>
                {filter.label}
              </option>
            ))}
          </select>
          <select
            className="ip-select"
            style={{ width: 'auto', flex: 'none' }}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-label="按来源筛选"
            title="按来源筛选"
          >
            {SOURCE_FILTERS.map((filter) => (
              <option key={filter.id} value={filter.id}>
                {filter.label}
              </option>
            ))}
          </select>
          <select
            className="ip-select"
            style={{ width: 'auto', flex: 'none' }}
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value)}
            aria-label="按时间范围筛选"
            title="按时间范围筛选"
          >
            {TIME_FILTERS.map((filter) => (
              <option key={filter.id} value={filter.id}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="panel-toolbar-actions">
          <button
            className="btn compact"
            disabled={busy}
            onClick={() => void exportCsv()}
            title="导出磁盘上的完整历史，不受当前筛选影响"
          >
            {busy ? '导出中…' : '导出全部 CSV'}
          </button>
          <button
            className="btn subtle compact"
            onClick={() => void api.historyClear()}
            title="会先弹出确认"
          >
            清空
          </button>
        </div>
      </div>
      {message ? <div className="panel-message">{message}</div> : null}

      {history.length === 0 ? (
        <div className="inbox-empty history-empty">
          <h3>还没有审批历史</h3>
          <p>每次允许、拒绝、超时或终端处理都会记录在这里，可按会话与结果回溯。</p>
          <button className="btn compact" onClick={onOpenInbox}>
            去待审批
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="inbox-empty">
          <h3>没有匹配的记录</h3>
          <p>试试清空搜索词或调整结果、风险、来源与时间筛选。</p>
        </div>
      ) : (
        <>
          <div className="history-summary">
            显示最近 300 条 · 共 {history.length} 条 · 当前显示 {filtered.length} 条
            <span>导出全部 CSV 会读取磁盘上的完整历史，不受当前筛选影响</span>
          </div>
          <div className="history-list">
            {filtered.map((record) => (
              <div className={`history-row decision-${record.decision}`} key={record.id}>
                <div className="history-time">
                  <b>{formatDateTime(record.ts)}</b>
                  <span>{formatRelative(record.ts, now)}</span>
                </div>
                <div className="history-main">
                  <div className="history-line">
                    <span
                      className="session-dot"
                      style={{ background: sessionColor(record.sessionKey) }}
                      aria-hidden="true"
                    />
                    <b>{record.sessionLabel}</b>
                    <span className="session-origin">{record.origin}</span>
                    <span className="tool-badge">{record.tool}</span>
                    <span className={`risk-badge risk-${record.risk}`}>
                      {RISK_LABEL[record.risk] || record.risk}
                    </span>
                    <span className={`decision-badge decision-${record.decision}`}>
                      {DECISION_LABEL[record.decision] || record.decision}
                    </span>
                    <span className="history-source">
                      {SOURCE_LABEL[record.source] || record.source}
                    </span>
                  </div>
                  <code className="history-command">{record.command || record.message}</code>
                </div>
                <div className="history-latency">
                  <b>{record.latencyMs >= 1000 ? `${(record.latencyMs / 1000).toFixed(1)}s` : `${record.latencyMs}ms`}</b>
                  <span>响应</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
