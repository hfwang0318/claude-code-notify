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

export default function HistoryPanel({ history, now, onOpenInbox }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [decision, setDecision] = useState('all')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return history.filter((record) => {
      if (decision !== 'all' && record.decision !== decision) return false
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
  }, [decision, history, query])

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
        <div className="panel-toolbar-actions">
          <button className="btn compact" disabled={busy} onClick={() => void exportCsv()}>
            {busy ? '导出中…' : '导出 CSV'}
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
          <p>试试清空搜索词或切换结果筛选。</p>
        </div>
      ) : (
        <>
          <div className="history-summary">
            共 {history.length} 条 · 当前显示 {filtered.length} 条
            <span>记录保存在 ~/.claude-notify/history.jsonl</span>
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
