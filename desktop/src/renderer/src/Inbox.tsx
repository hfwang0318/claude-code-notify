import { useEffect, useMemo, useState } from 'react'
import type { AppState, ApprovalItem } from '../../shared/types'
import {
  approvalCommand,
  groupBySession,
  questionSummary,
  remainingSeconds,
  riskLabel,
  sessionColor,
  shortSessionId,
  sortByDeadline
} from '../../shared/session'
import { clusterApprovals } from '../../shared/approvals'
import { formatRelative, minutesUntilTomorrow } from './format'
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
      title: item.sessionLabel,
      topic: '',
      shortId: shortSessionId(item.sessionId),
      task: item.task,
      branch: item.branch,
      ordinal: 1,
      groupSize: 1,
      firstSeen: item.createdAt,
      customLabel: false,
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
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
  const [bulkAllowConfirm, setBulkAllowConfirm] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase()
    return state.pending.filter((item) => {
      if (riskFilter !== 'all' && item.risk.level !== riskFilter) return false
      if (!text) return true
      const session = state.sessions.find((candidate) => candidate.key === item.sessionKey)
      return [
        item.sessionLabel,
        session?.title,
        session?.task,
        session?.branch,
        item.task,
        item.origin,
        item.project,
        item.tool,
        approvalCommand(item)
      ]
        .join(' ')
        .toLowerCase()
        .includes(text)
    })
  }, [query, riskFilter, state.pending, state.sessions])
  const groups = useMemo(() => groupBySession(sortByDeadline(visible)), [visible])
  const allClusters = useMemo(() => clusterApprovals(visible), [visible])
  const selectedClusters = useMemo(
    () => allClusters.filter((cluster) => selectedGroups.has(cluster.key)),
    [allClusters, selectedGroups]
  )
  const selectedItemIds = useMemo(
    () => selectedClusters.flatMap((cluster) => cluster.items.map((item) => item.id)),
    [selectedClusters]
  )
  const canBulkAllow =
    selectedClusters.length > 0 &&
    selectedClusters.every((cluster) =>
      cluster.items.every((item) => item.risk.level === 'low')
    )

  useEffect(() => {
    if (!bulkAllowConfirm) return
    const timer = window.setTimeout(() => setBulkAllowConfirm(false), 4000)
    return () => window.clearTimeout(timer)
  }, [bulkAllowConfirm])

  useEffect(() => {
    if (allClusters.length === 0) {
      if (activeKey) setActiveKey(null)
      return
    }
    if (!activeKey || !allClusters.some((cluster) => cluster.key === activeKey)) {
      setActiveKey(allClusters[0].key)
    }
  }, [activeKey, allClusters])

  useEffect(() => {
    setSelectedGroups((current) => {
      const live = new Set(allClusters.map((cluster) => cluster.key))
      const next = new Set([...current].filter((key) => live.has(key)))
      return next.size === current.size ? current : next
    })
    setBulkAllowConfirm(false)
  }, [allClusters])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        document.querySelector('.modal-backdrop')
      ) {
        return
      }
      if (allClusters.length === 0) return
      const index = Math.max(
        0,
        allClusters.findIndex((cluster) => cluster.key === activeKey)
      )
      const focus = (next: number): void => {
        const bounded = (next + allClusters.length) % allClusters.length
        setActiveKey(allClusters[bounded].key)
        const cards = document.querySelectorAll<HTMLElement>('.inbox-item')
        cards[bounded]?.scrollIntoView({ block: 'nearest' })
      }
      const active = allClusters[index]
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault()
        focus(index + 1)
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault()
        focus(index - 1)
      } else if (event.key === 'a' || event.key === 'A') {
        event.preventDefault()
        approve(active.items)
      } else if (event.key === 'd' || event.key === 'D') {
        event.preventDefault()
        respondCluster(active.items, 'deny')
      } else if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        respondCluster(active.items, 'ask')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeKey, allClusters])

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
    void api.respondMany(items.map((item) => item.id), 'ask')
    setConfirmBatch(null)
  }

  const approve = (items: ApprovalItem[]): void => {
    const item = items[0]
    if (!item) return
    if (item.kind === 'question' || item.risk.level === 'high') {
      void api.selectApproval(item.id)
      return
    }
    void api.respondMany(items.map((entry) => entry.id), 'allow')
  }

  const respondCluster = (items: ApprovalItem[], decision: string): void => {
    void api.respondMany(items.map((item) => item.id), decision)
  }

  const toggleSelect = (key: string): void => {
    setSelectedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setBulkAllowConfirm(false)
  }

  const clearSelection = (): void => {
    setSelectedGroups(new Set())
    setBulkAllowConfirm(false)
  }

  const bulkDecision = (decision: string): void => {
    if (selectedItemIds.length === 0) return
    void api.respondMany(selectedItemIds, decision)
    clearSelection()
  }

  const bulkAllow = (): void => {
    if (!canBulkAllow || selectedItemIds.length === 0) return
    if (!bulkAllowConfirm) {
      setBulkAllowConfirm(true)
      return
    }
    bulkDecision('allow')
  }

  const snoozeCluster = (items: ApprovalItem[], minutes: number): void => {
    for (const item of items) void api.snoozeApproval(item.id, minutes)
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
            Claude Code 请求权限或提问时会按会话出现在这里。现在可以回到终端继续工作，
            审批到了再回来处理。
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

      {selectedGroups.size > 0 ? (
        <div className="inbox-bulk" role="region" aria-label="批量操作">
          <div>
            已选 <b>{selectedClusters.length}</b> 组 / <b>{selectedItemIds.length}</b> 条
          </div>
          <div className="inbox-bulk-actions">
            <button className="btn subtle compact" onClick={() => bulkDecision('ask')}>
              全部交给终端
            </button>
            <button className="btn compact" onClick={() => bulkDecision('deny')}>
              全部拒绝
            </button>
            <button
              className={`btn compact ${bulkAllowConfirm ? 'danger' : 'primary'}`}
              disabled={!canBulkAllow}
              title={
                canBulkAllow
                  ? '仅对低风险请求生效'
                  : '只有全部为低风险的请求才能批量允许'
              }
              onClick={bulkAllow}
            >
              {bulkAllowConfirm ? '再点一次确认允许' : '批量允许低风险'}
            </button>
            <button className="link" onClick={clearSelection}>
              取消选择
            </button>
          </div>
        </div>
      ) : null}

      {visible.length !== state.pending.length || state.expired.length > 0 ? (
        <div className="inbox-summary">
          <div>
            {visible.length !== state.pending.length ? (
              <>
                筛选后 <b>{visible.length}</b> 条（共 <b>{state.pending.length}</b> 条）
              </>
            ) : null}
          </div>
          {state.expired.length > 0 ? (
            <button className="link" onClick={() => setShowExpired((value) => !value)}>
              {state.expired.length} 条已回退{showExpired ? ' · 收起' : ' · 查看'}
            </button>
          ) : null}
        </div>
      ) : null}

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
        const pausedGroup = group.items.every((item) => item.paused)
        const expiresIn = pausedGroup
          ? 0
          : Math.min(
              ...group.items
                .filter((item) => !item.paused)
                .map((item) => remainingSeconds(item.timeoutAt, now))
            )
        return (
          <section
            className={`inbox-session ${focused ? 'focused' : ''}`}
            key={group.key}
            id={`session-${encodeURIComponent(group.key)}`}
            style={
              {
                '--session-color': meta.color || sessionColor(group.key)
              } as React.CSSProperties
            }
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
                    placeholder={meta.task || meta.title}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={() => commitRename(group.key)}
                    aria-label="会话名称"
                  />
                </form>
              ) : (
                <button
                  className="session-name"
                  title={`${meta.cwd || meta.project} · 点击重命名`}
                  onClick={() =>
                    startRename(group.key, meta.customLabel ? meta.label : meta.task || meta.label)
                  }
                >
                  {meta.title}
                </button>
              )}
              {meta.shortId ? <span className="session-id">#{meta.shortId}</span> : null}
              {meta.sessionId ? (
                <button
                  className="link session-resume"
                  title="复制恢复该会话的命令"
                  onClick={() => void api.copy(`claude --resume ${meta.sessionId}`)}
                >
                  恢复
                </button>
              ) : null}
              {!meta.title.includes(meta.origin) ? (
                <span className="session-origin">{meta.origin}</span>
              ) : null}
              <span className="session-count">{group.items.length} 条</span>
              {pausedGroup ? (
                <span className="session-urgent paused">已暂停</span>
              ) : expiresIn <= 20 ? (
                <span className="session-urgent">{expiresIn}s</span>
              ) : null}
              <div className="session-tools">
                <button
                  className={`icon-btn ${muted ? 'active' : ''}`}
                  title={muted ? '取消静音提醒' : '静音提醒 30 分钟'}
                  aria-label={muted ? '取消静音提醒' : '静音提醒 30 分钟'}
                  onClick={() => mute(group.key, muted)}
                >
                  {muted ? <BellOffIcon /> : <BellIcon />}
                </button>
                <select
                  className="mute-select"
                  value=""
                  onChange={(event) => {
                    const value = event.target.value
                    const minutes =
                      value === 'tomorrow' ? minutesUntilTomorrow() : Number(value)
                    if (minutes > 0) void api.muteSession(group.key, minutes)
                    event.currentTarget.value = ''
                  }}
                  aria-label="静音时长"
                  title="按会话静音"
                >
                  <option value="">静音…</option>
                  <option value="30">30 分钟</option>
                  <option value="60">1 小时</option>
                  <option value="240">4 小时</option>
                  <option value="tomorrow">直到明天</option>
                </select>
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

            {meta.task || meta.branch ? (
              <div className="inbox-session-task">
                {meta.task ? (
                  <>
                    <span className="inbox-session-task-label">任务</span>
                    <span className="inbox-session-task-text" title={meta.task}>
                      {meta.task}
                    </span>
                  </>
                ) : (
                  <span className="inbox-session-task-text faint">钩子未上报任务摘要</span>
                )}
                {meta.branch ? (
                  <span className="inbox-session-branch" title="当前分支">
                    {meta.branch}
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="inbox-items">
              {clusterApprovals(group.items).map((cluster) => {
                const item = cluster.representative
                const items = cluster.items
                const duplicate = items.length
                const paused = items.every((entry) => entry.paused)
                const left = paused
                  ? 0
                  : Math.min(
                      ...items
                        .filter((entry) => !entry.paused)
                        .map((entry) => remainingSeconds(entry.timeoutAt, now))
                    )
                const command = approvalCommand(item)
                const selected = selectedGroups.has(cluster.key)
                return (
                  <article
                    className={`inbox-item risk-${item.risk.level} ${
                      left <= 15 && !paused ? 'urgent' : ''
                    } ${selected ? 'selected' : ''} ${
                      activeKey === cluster.key ? 'active' : ''
                    }`}
                    key={cluster.key}
                    onClick={() => setActiveKey(cluster.key)}
                  >
                    <div className="inbox-item-top">
                      <input
                        type="checkbox"
                        className="inbox-select"
                        checked={selected}
                        onChange={() => toggleSelect(cluster.key)}
                        aria-label={`选择 ${command || item.message}`}
                      />
                      <span className="tool-badge">{item.tool}</span>
                      <span className={`risk-badge risk-${item.risk.level}`}>
                        {riskLabel(item.risk.level)}
                      </span>
                      {item.kind === 'question' ? (
                        <span className="kind-badge">问答</span>
                      ) : null}
                      {item.snoozedUntil && item.snoozedUntil > now ? (
                        <span className="kind-badge">已稍后</span>
                      ) : null}
                      {duplicate > 1 ? (
                        <span className="kind-badge duplicate">相同 ×{duplicate}</span>
                      ) : null}
                      {item.correlation === 'unmatched' ? (
                        <span className="kind-badge warn">无法关联终端</span>
                      ) : null}
                      <span className={`inbox-time ${paused ? 'paused' : ''}`}>
                        {paused ? '已暂停' : `${left}s`}
                      </span>
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
                        {duplicate > 1 ? ` · ${duplicate} 条相同请求` : ''}
                      </span>
                      <div className="inbox-actions">
                        <button
                          className="btn subtle compact"
                          onClick={() => {
                            for (const entry of items) {
                              void api.pauseApproval(entry.id, !paused)
                            }
                          }}
                        >
                          {paused ? '继续' : '暂停'}
                        </button>
                        <select
                          className="mute-select"
                          value=""
                          onChange={(event) => {
                            const minutes = Number(event.target.value)
                            if (minutes > 0) snoozeCluster(items, minutes)
                            event.currentTarget.value = ''
                          }}
                          aria-label="稍后提醒"
                          title="稍后提醒，倒计时继续"
                        >
                          <option value="">稍后…</option>
                          <option value="1">1 分钟</option>
                          <option value="5">5 分钟</option>
                          <option value="15">15 分钟</option>
                        </select>
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
                              onClick={() => approve(items)}
                            >
                              {item.risk.level === 'high' ? '检查并允许' : '允许'}
                            </button>
                            <button
                              className="btn compact"
                              onClick={() => respondCluster(items, 'deny')}
                            >
                              拒绝
                            </button>
                          </>
                        ) : null}
                        <button
                          className="btn subtle compact"
                          onClick={() => respondCluster(items, 'ask')}
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
