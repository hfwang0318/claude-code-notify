import { useEffect, useMemo, useState } from 'react'
import type { AppState, ApprovalItem } from '../../shared/types'
import {
  approvalCommand,
  groupBySession,
  questionSummary,
  remainingSeconds,
  riskLabel,
  sessionColor,
  sortByDeadline
} from '../../shared/session'
import { formatRelative } from './format'
import { api } from './api'

interface Props {
  state: AppState
  now: number
  focusSessionKey: string | null
  onClearFocus: () => void
  onOpenDeploy: () => void
  onOpenHistory: () => void
}

function BellIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function BellOffIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8.7 3A6 6 0 0 1 18 8c0 2.3.7 4.2 1.5 5.6" />
      <path d="M17 17H4s3-2 3-9a6 6 0 0 1 .6-2.6" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  )
}

function sessionMeta(state: AppState, item: ApprovalItem) {
  return (
    state.sessions.find((session) => session.key === item.sessionKey) || {
      key: item.sessionKey,
      sessionId: item.sessionId,
      origin: item.origin,
      label: item.sessionLabel,
      project: item.project,
      cwd: item.cwd,
      tty: item.tty,
      terminal: item.terminal,
      lastSeen: item.createdAt,
      waiting: 1,
      state: 'waiting' as const,
      color: sessionColor(item.sessionKey),
      mutedUntil: null
    }
  )
}

export default function Inbox({
  state,
  now,
  focusSessionKey,
  onClearFocus,
  onOpenDeploy,
  onOpenHistory
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [confirmBatch, setConfirmBatch] = useState<string | null>(null)
  const [showExpired, setShowExpired] = useState(false)
  const [query, setQuery] = useState('')
  const [riskFilter, setRiskFilter] = useState<'all' | 'high' | 'medium'>('all')

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase()
    return state.pending.filter((item) => {
      if (riskFilter !== 'all' && item.risk.level !== riskFilter) return false
      if (!text) return true
      return [item.sessionLabel, item.origin, item.project, item.tool, approvalCommand(item)]
        .join(' ')
        .toLowerCase()
        .includes(text)
    })
  }, [query, riskFilter, state.pending])
  const groups = useMemo(() => groupBySession(sortByDeadline(visible)), [visible])
  const waitingSessions = new Set(visible.map((item) => item.sessionKey)).size

  useEffect(() => {
    if (!focusSessionKey) return
    const element = document.getElementById(
      `session-${encodeURIComponent(focusSessionKey)}`
    )
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const timer = window.setTimeout(onClearFocus, 2400)
    return () => window.clearTimeout(timer)
  }, [focusSessionKey, onClearFocus])

  const startRename = (key: string, label: string): void => {
    setEditing(key)
    setNameDraft(label)
  }

  const commitRename = (key: string): void => {
    if (nameDraft.trim()) void api.renameSession(key, nameDraft.trim())
    setEditing(null)
  }

  const mute = (key: string, muted: boolean): void => {
    void api.muteSession(key, muted ? 0 : 30)
  }

  const batchAsk = (items: ApprovalItem[]): void => {
    for (const item of items) void api.respond(item.id, 'ask')
    setConfirmBatch(null)
  }

  const approve = (item: ApprovalItem): void => {
    if (item.risk.level === 'high') {
      void api.selectApproval(item.id)
      return
    }
    void api.respond(item.id, 'allow')
  }

  if (state.pending.length === 0) {
    return (
      <div className="inbox">
        {state.expired.length > 0 ? (
          <div className="inbox-expired">
            <div>
              <b>{state.expired.length} 条审批已回退终端</b>
              <span>桌面端不会再次提交这些决定；可在历史里查看。</span>
            </div>
            <button className="btn compact" onClick={() => api.acknowledgeExpired()}>
              全部知道了
            </button>
          </div>
        ) : null}
        <div className="inbox-empty">
          <div className="inbox-empty-mark" aria-hidden="true" />
          <h3>没有待审批</h3>
          <p>
            本机或服务器上的 Claude Code 请求权限时，会在这里按会话分组出现；
            置顶弹窗负责即时提醒，这个收件箱负责集中处理。
          </p>
          <div className="inbox-empty-actions">
            <button className="btn compact" onClick={() => void api.testApproval()}>
              发送测试审批
            </button>
            <button className="btn compact" onClick={onOpenDeploy}>
              接入 / 部署
            </button>
            <button className="btn subtle compact" onClick={onOpenHistory}>
              查看历史
            </button>
          </div>
          <div className="inbox-empty-meta">
            {state.sessions.filter((session) => session.state === 'waiting').length} 个会话等待中 ·{' '}
            {state.server.notified} 条通知 · 版本 {state.app.version}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="inbox">
      <div className="inbox-toolbar">
        <input
          className="search-input"
          value={query}
          placeholder="搜索会话、项目、工具或命令…"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索待审批"
        />
        <div className="filter-chips" role="group" aria-label="风险筛选">
          {[
            { id: 'all' as const, label: '全部' },
            { id: 'high' as const, label: '高风险' },
            { id: 'medium' as const, label: '需留意' }
          ].map((filter) => (
            <button
              key={filter.id}
              className={riskFilter === filter.id ? 'chip active' : 'chip'}
              aria-pressed={riskFilter === filter.id}
              onClick={() => setRiskFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="inbox-summary">
        <div>
          <b>{visible.length}</b> 条待审批 · <b>{waitingSessions}</b> 个会话
          {visible.length !== state.pending.length ? `（共 ${state.pending.length} 条）` : ''}
          <span className="inbox-summary-hint">按剩余时间排序，最早回退的排在前面</span>
        </div>
        {state.expired.length > 0 ? (
          <button className="link" onClick={() => setShowExpired((value) => !value)}>
            {state.expired.length} 条已回退{showExpired ? ' · 收起' : ' · 查看'}
          </button>
        ) : null}
      </div>

      {showExpired ? (
        <div className="expired-strip">
          {state.expired.map((entry) => (
            <div className="expired-strip-row" key={entry.id}>
              <span
                className="session-dot"
                style={{ background: sessionColor(entry.sessionKey) }}
                aria-hidden="true"
              />
              <b>{entry.sessionLabel}</b>
              <span>{entry.tool}</span>
              <code>{approvalCommand(entry).slice(0, 80) || entry.message}</code>
              <time>{formatRelative(entry.createdAt, now)}</time>
              <button className="link" onClick={() => api.acknowledgeExpired(entry.id)}>
                关闭
              </button>
            </div>
          ))}
          <button className="btn subtle compact" onClick={() => api.acknowledgeExpired()}>
            全部知道了
          </button>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="inbox-empty">
          <h3>没有匹配的待审批</h3>
          <p>试试清空搜索词或切换风险筛选。</p>
        </div>
      ) : null}

      {groups.map((group) => {
        const first = group.items[0]
        const meta = sessionMeta(state, first)
        const muted = (meta.mutedUntil || 0) > now
        const focused = focusSessionKey === group.key
        const expiresIn = remainingSeconds(first.timeoutAt, now)
        return (
          <section
            className={`inbox-session ${focused ? 'focused' : ''}`}
            key={group.key}
            id={`session-${encodeURIComponent(group.key)}`}
          >
            <header className="inbox-session-head">
              <span
                className="session-dot"
                style={{ background: meta.color || sessionColor(group.key) }}
                aria-hidden="true"
              />
              {editing === group.key ? (
                <form
                  className="session-rename"
                  onSubmit={(event) => {
                    event.preventDefault()
                    commitRename(group.key)
                  }}
                >
                  <input
                    value={nameDraft}
                    autoFocus
                    maxLength={60}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={() => commitRename(group.key)}
                    aria-label="会话名称"
                  />
                </form>
              ) : (
                <button
                  className="session-name"
                  title={`${meta.cwd || meta.project} · 点击重命名`}
                  onClick={() => startRename(group.key, meta.label)}
                >
                  {meta.label}
                </button>
              )}
              {!meta.label.includes(meta.origin) ? (
                <span className="session-origin">{meta.origin}</span>
              ) : null}
              <span className="session-count">{group.items.length} 条</span>
              {expiresIn <= 20 ? <span className="session-urgent">{expiresIn}s</span> : null}
              <div className="session-tools">
                <button
                  className={`icon-btn ${muted ? 'active' : ''}`}
                  title={muted ? '取消静音提醒' : '静音提醒 30 分钟'}
                  aria-label={muted ? '取消静音提醒' : '静音提醒 30 分钟'}
                  onClick={() => mute(group.key, muted)}
                >
                  {muted ? <BellOffIcon /> : <BellIcon />}
                </button>
                {confirmBatch === group.key ? (
                  <>
                    <button
                      className="btn danger compact"
                      onClick={() => batchAsk(group.items)}
                    >
                      确认全部交给终端
                    </button>
                    <button className="btn subtle compact" onClick={() => setConfirmBatch(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    className="btn subtle compact"
                    onClick={() => setConfirmBatch(group.key)}
                  >
                    全部交给终端
                  </button>
                )}
              </div>
            </header>

            <div className="inbox-items">
              {group.items.map((item) => {
                const left = remainingSeconds(item.timeoutAt, now)
                const command = approvalCommand(item)
                return (
                  <article
                    className={`inbox-item risk-${item.risk.level} ${
                      left <= 15 ? 'urgent' : ''
                    }`}
                    key={item.id}
                  >
                    <div className="inbox-item-top">
                      <span className="tool-badge">{item.tool}</span>
                      <span className={`risk-badge risk-${item.risk.level}`}>
                        {riskLabel(item.risk.level)}
                      </span>
                      {item.kind === 'question' ? (
                        <span className="kind-badge">问答</span>
                      ) : null}
                      {item.correlation === 'unmatched' ? (
                        <span className="kind-badge warn">无法关联终端</span>
                      ) : null}
                      <span className="inbox-time">{left}s</span>
                    </div>
                    <button
                      className="inbox-command"
                      title={command || item.message}
                      onClick={() => void api.selectApproval(item.id)}
                    >
                      {item.kind === 'question'
                        ? questionSummary(item.questions) || item.message
                        : command || item.message}
                    </button>
                    {item.risk.level === 'high' && item.risk.reasons.length > 0 ? (
                      <div className="inbox-risk-reasons">
                        {item.risk.reasons.join(' · ')}
                      </div>
                    ) : null}
                    <div className="inbox-item-foot">
                      <span className="inbox-created">
                        {formatRelative(item.createdAt, now)} · {item.origin}
                      </span>
                      <div className="inbox-actions">
                        <button
                          className="btn subtle compact"
                          onClick={() => void api.selectApproval(item.id)}
                        >
                          打开
                        </button>
                        {item.kind === 'permission' ? (
                          <>
                            <button
                              className={`btn compact ${
                                item.risk.level === 'high' ? 'danger' : 'primary'
                              }`}
                              onClick={() => approve(item)}
                            >
                              {item.risk.level === 'high' ? '检查并允许' : '允许'}
                            </button>
                            <button
                              className="btn compact"
                              onClick={() => void api.respond(item.id, 'deny')}
                            >
                              拒绝
                            </button>
                          </>
                        ) : null}
                        <button
                          className="btn subtle compact"
                          onClick={() => void api.respond(item.id, 'ask')}
                        >
                          终端
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
