import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ApprovalItem } from '../../shared/types'
import {
  approvalCommand,
  groupBySession,
  questionSummary,
  remainingSeconds,
  riskLabel,
  sessionColor,
  shortSessionId,
  slackSeconds,
  sortForTriage,
  URGENT_SECONDS
} from '../../shared/session'
import { estimateHandlingMs } from '../../shared/analytics'
import { clusterApprovals, crossSessionClusters } from '../../shared/approvals'
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
  const [bulkDenyConfirm, setBulkDenyConfirm] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<'deadline' | 'slack'>('deadline')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)
  const activeIndexRef = useRef(0)
  const receiptTimer = useRef<number | null>(null)

  const estimateFor = (item: ApprovalItem): number =>
    estimateHandlingMs(state.history, item.tool, item.risk.level)

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
  const ordered = useMemo(() => {
    if (sortMode === 'deadline') return sortForTriage(visible)
    return [...visible].sort((left, right) => {
      const leftSlack = slackSeconds(
        remainingSeconds(left.timeoutAt, now),
        estimateHandlingMs(state.history, left.tool, left.risk.level)
      )
      const rightSlack = slackSeconds(
        remainingSeconds(right.timeoutAt, now),
        estimateHandlingMs(state.history, right.tool, right.risk.level)
      )
      return leftSlack - rightSlack || left.timeoutAt - right.timeoutAt
    })
  }, [visible, sortMode, state.history, now])
  const groups = useMemo(() => groupBySession(ordered), [ordered])
  const allClusters = useMemo(() => clusterApprovals(ordered), [ordered])
  const snoozedCount = state.pending.filter(
    (item) => item.snoozedUntil && item.snoozedUntil > now
  ).length
  const pendingGroupsCount = clusterApprovals(
    state.pending.filter((item) => !item.snoozedUntil || item.snoozedUntil <= now)
  ).length
  const allPaused =
    state.pending.length > 0 && state.pending.every((item) => item.paused)
  const waitingSessions = state.sessions.filter((session) => session.waiting > 0)
  const allMuted =
    waitingSessions.length > 0 &&
    waitingSessions.every((session) => (session.mutedUntil || 0) > now)
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
  const selectedHasHigh = selectedClusters.some((cluster) =>
    cluster.items.some((item) => item.risk.level === 'high')
  )

  useEffect(() => {
    if (!bulkAllowConfirm) return
    const timer = window.setTimeout(() => setBulkAllowConfirm(false), 4000)
    return () => window.clearTimeout(timer)
  }, [bulkAllowConfirm])

  useEffect(() => {
    if (!bulkDenyConfirm) return
    const timer = window.setTimeout(() => setBulkDenyConfirm(false), 4000)
    return () => window.clearTimeout(timer)
  }, [bulkDenyConfirm])

  useEffect(() => {
    const index = allClusters.findIndex((cluster) => cluster.key === activeKey)
    if (index >= 0) activeIndexRef.current = index
  }, [activeKey, allClusters])

  useEffect(() => {
    if (allClusters.length === 0) {
      if (activeKey) setActiveKey(null)
      return
    }
    if (!activeKey || !allClusters.some((cluster) => cluster.key === activeKey)) {
      // Acting on a card must advance to its neighbour, not jump to the top;
      // otherwise keyboard triage throws the user back to the first item.
      const next = allClusters[Math.min(activeIndexRef.current, allClusters.length - 1)]
      setActiveKey(next.key)
    }
  }, [activeKey, allClusters])

  useEffect(() => {
    setSelectedGroups((current) => {
      const live = new Set(allClusters.map((cluster) => cluster.key))
      const next = new Set([...current].filter((key) => live.has(key)))
      return next.size === current.size ? current : next
    })
    setBulkAllowConfirm(false)
    setBulkDenyConfirm(false)
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
      if (
        target?.tagName === 'BUTTON' &&
        (event.key === ' ' || event.key === 'Enter')
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
      const hasSelection = selectedGroups.size > 0
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault()
        focus(index + 1)
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault()
        focus(index - 1)
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        toggleSelect(active.key)
      } else if (event.key === 'Escape' && hasSelection) {
        event.preventDefault()
        clearSelection()
      } else if (event.key === 'a' || event.key === 'A') {
        event.preventDefault()
        if (hasSelection) bulkAllow()
        else approve(active.items)
      } else if (event.key === 'd' || event.key === 'D') {
        event.preventDefault()
        if (hasSelection) bulkDeny()
        else respondCluster(active.items, 'deny')
      } else if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        if (hasSelection) bulkDecision('ask')
        else respondCluster(active.items, 'ask')
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault()
        snoozeCluster(active.items, 5)
      } else if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        pauseCluster(active.items, !active.items.every((item) => item.paused))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeKey, allClusters, selectedGroups])

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

  const pushReceipt = (text: string): void => {
    setReceipt(text)
    if (receiptTimer.current) window.clearTimeout(receiptTimer.current)
    receiptTimer.current = window.setTimeout(() => setReceipt(null), 2400)
  }

  const act = async (ids: string[], decision: string, label: string): Promise<void> => {
    if (ids.length === 0 || busy) return
    setBusy(true)
    try {
      await api.respondMany(ids, decision)
      pushReceipt(`${label} · ${ids.length} 条`)
    } finally {
      setBusy(false)
    }
  }

  const batchAsk = (items: ApprovalItem[]): void => {
    void act(
      items.map((item) => item.id),
      'ask',
      '已交给终端'
    )
    setConfirmBatch(null)
  }

  const approve = (items: ApprovalItem[]): void => {
    const item = items[0]
    if (!item) return
    if (item.kind === 'question' || item.risk.level === 'high') {
      void api.selectApproval(item.id)
      return
    }
    void act(
      items.map((entry) => entry.id),
      'allow',
      `已允许 · ${item.tool}`
    )
  }

  const respondCluster = (items: ApprovalItem[], decision: string): void => {
    const label =
      decision === 'deny' ? '已拒绝' : decision === 'ask' ? '已交给终端' : '已处理'
    void act(
      items.map((item) => item.id),
      decision,
      label
    )
  }

  const pauseCluster = (items: ApprovalItem[], paused: boolean): void => {
    for (const item of items) void api.pauseApproval(item.id, paused)
    pushReceipt(paused ? '本组倒计时已暂停' : '本组倒计时已恢复')
  }

  const toggleSelect = (key: string): void => {
    setSelectedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setBulkAllowConfirm(false)
    setBulkDenyConfirm(false)
  }

  const selectAllGroup = (items: ApprovalItem[]): void => {
    const keys = clusterApprovals(items).map((cluster) => cluster.key)
    setSelectedGroups((current) => {
      const allSelected = keys.length > 0 && keys.every((key) => current.has(key))
      const next = new Set(current)
      for (const key of keys) {
        if (allSelected) next.delete(key)
        else next.add(key)
      }
      return next
    })
    setBulkAllowConfirm(false)
    setBulkDenyConfirm(false)
  }

  const clearSelection = (): void => {
    setSelectedGroups(new Set())
    setBulkAllowConfirm(false)
    setBulkDenyConfirm(false)
  }

  const bulkDecision = (decision: string): void => {
    if (selectedItemIds.length === 0) return
    const label =
      decision === 'allow' ? '已批量允许' : decision === 'deny' ? '已批量拒绝' : '已批量交给终端'
    void act(selectedItemIds, decision, label)
    clearSelection()
  }

  const bulkAllow = (): void => {
    if (selectedItemIds.length === 0) return
    if (!canBulkAllow) {
      pushReceipt('选中项含高风险，批量允许只支持全部低风险')
      return
    }
    if (!bulkAllowConfirm) {
      setBulkAllowConfirm(true)
      setBulkDenyConfirm(false)
      return
    }
    bulkDecision('allow')
  }

  const bulkDeny = (): void => {
    if (selectedItemIds.length === 0) return
    if (!bulkDenyConfirm) {
      setBulkDenyConfirm(true)
      setBulkAllowConfirm(false)
      return
    }
    bulkDecision('deny')
  }

  const snoozeCluster = (items: ApprovalItem[], minutes: number): void => {
    const left = Math.min(
      ...items.filter((item) => !item.paused).map((item) => remainingSeconds(item.timeoutAt))
    )
    if (Number.isFinite(left) && left <= minutes * 60) {
      pushReceipt(`剩余 ${left}s，${minutes} 分钟后提醒会直接超时`)
      return
    }
    for (const item of items) void api.snoozeApproval(item.id, minutes)
    pushReceipt(`已稍后 ${minutes} 分钟 · 倒计时继续`)
  }

  useEffect(
    () => () => {
      if (receiptTimer.current) window.clearTimeout(receiptTimer.current)
    },
    []
  )

  if (state.pending.length === 0) {
    const rolledBack = state.expired.length + state.skipped.length
    return (
      <div className="inbox">
        {rolledBack > 0 ? (
          <div className="inbox-expired">
            <div>
              <b>{rolledBack} 条审批已回退终端</b>
              <span>
                超时 {state.expired.length} 条 · 队列过载 {state.skipped.length} 条；
                桌面端不会再次提交这些决定。
              </span>
            </div>
            <button
              className="btn compact"
              onClick={() => {
                void api.acknowledgeExpired()
                void api.clearSkipped()
              }}
            >
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
        <div className="filter-chips" role="group" aria-label="排序">
          <button
            className={sortMode === 'deadline' ? 'chip active' : 'chip'}
            aria-pressed={sortMode === 'deadline'}
            onClick={() => setSortMode('deadline')}
          >
            按截止
          </button>
          <button
            className={sortMode === 'slack' ? 'chip active' : 'chip'}
            aria-pressed={sortMode === 'slack'}
            onClick={() => setSortMode('slack')}
            title="剩余时间减去按历史估算的处理时间"
          >
            按余量
          </button>
        </div>
      </div>

      <div className="inbox-tools">
        <span className="inbox-tools-hint">
          {snoozedCount > 0 ? `${snoozedCount} 条稍后提醒 · ` : ''}
          共 {pendingGroupsCount} 组 / {state.pending.length} 条
        </span>
        <button
          className="btn subtle compact"
          onClick={() => void api.pauseAll(!allPaused)}
        >
          {allPaused ? '继续全部' : '暂停全部'}
        </button>
        <button
          className="btn subtle compact"
          onClick={() => void api.muteAll(allMuted ? 0 : 30)}
        >
          {allMuted ? '全部取消静音' : '全部静音 30 分钟'}
        </button>
        {state.expired.length + state.skipped.length > 0 ? (
          <button className="link" onClick={() => setShowExpired((value) => !value)}>
            回退记录 {state.expired.length + state.skipped.length}
          </button>
        ) : null}
      </div>

      {receipt ? (
        <div className="inbox-receipt" role="status" aria-live="polite">
          {receipt}
        </div>
      ) : null}

      {selectedGroups.size > 0 ? (
        <div className="inbox-bulk" role="region" aria-label="批量操作">
          <div>
            已选 <b>{selectedClusters.length}</b> 组 / <b>{selectedItemIds.length}</b> 条
            {selectedHasHigh ? <span className="bulk-warn"> · 含高风险</span> : null}
          </div>
          <div className="inbox-bulk-actions">
            <button
              className="btn subtle compact"
              disabled={busy}
              onClick={() => bulkDecision('ask')}
            >
              全部交给终端
            </button>
            <button
              className={`btn compact ${bulkDenyConfirm ? 'danger' : ''}`}
              disabled={busy}
              onClick={bulkDeny}
            >
              {bulkDenyConfirm
                ? `再点一次确认拒绝 ${selectedItemIds.length} 条`
                : '全部拒绝'}
            </button>
            <button
              className={`btn compact ${bulkAllowConfirm ? 'danger' : 'primary'}`}
              disabled={!canBulkAllow || busy}
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

      {visible.length !== state.pending.length ? (
        <div className="inbox-summary">
          <div>
            筛选后 <b>{visible.length}</b> 条（共 <b>{state.pending.length}</b> 条）
          </div>
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
              <time>{formatRelative(entry.createdAt, now)} · 超时</time>
              <button className="link" onClick={() => api.acknowledgeExpired(entry.id)}>
                关闭
              </button>
            </div>
          ))}
          {state.skipped.map((entry) => (
            <div className="expired-strip-row" key={entry.id}>
              <span className="skipped-dot" aria-hidden="true">
                ⤺
              </span>
              <b>{entry.sessionLabel}</b>
              <span>{entry.tool}</span>
              <code>{entry.command.slice(0, 80)}</code>
              <time>
                {formatRelative(entry.ts, now)} ·{' '}
                {entry.reason === 'overloaded' ? '队列过载' : '预计来不及'}
              </time>
              <button className="link" onClick={() => api.clearSkipped(entry.id)}>
                关闭
              </button>
            </div>
          ))}
          <button
            className="btn subtle compact"
            onClick={() => {
              void api.acknowledgeExpired()
              void api.clearSkipped()
            }}
          >
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
              <span className="session-count">
                {clusterApprovals(group.items).length} 组
              </span>
              {pausedGroup ? (
                <span className="session-urgent paused">已暂停</span>
              ) : expiresIn <= URGENT_SECONDS ? (
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
                <button
                  className="btn subtle compact"
                  onClick={() => selectAllGroup(group.items)}
                >
                  {clusterApprovals(group.items).every((cluster) =>
                    selectedGroups.has(cluster.key)
                  )
                    ? '取消全选'
                    : '全选本会话'}
                </button>
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
                const estimate = estimateFor(item)
                const entrySlack = paused ? null : slackSeconds(left, estimate)
                const cross = crossSessionClusters(state.pending).find((group) =>
                  group.items.some((entry) => entry.id === item.id)
                )
                const crossOthers = cross
                  ? cross.items.filter((entry) => entry.sessionKey !== item.sessionKey).length
                  : 0
                return (
                  <article
                    className={`inbox-item risk-${item.risk.level} ${
                      entrySlack !== null &&
                      (entrySlack <= 0 || left <= URGENT_SECONDS)
                        ? 'urgent'
                        : ''
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
                      {crossOthers > 0 ? (
                        <span className="kind-badge cross">
                          另有 {crossOthers} 会话同命令
                        </span>
                      ) : null}
                      {item.correlation === 'unmatched' ? (
                        <span className="kind-badge warn">无法关联终端</span>
                      ) : null}
                      {entrySlack !== null ? (
                        <span
                          className={`slack-chip ${
                            entrySlack <= 0 ? 'urgent' : entrySlack <= 10 ? 'tight' : ''
                          }`}
                          title={`剩余 ${left}s，按历史估算处理约 ${Math.round(estimate / 1000)}s`}
                        >
                          余量 {entrySlack}s
                        </span>
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
                          {[1, 5, 15].map((minutes) => (
                            <option
                              key={minutes}
                              value={minutes}
                              disabled={left <= minutes * 60}
                            >
                              {minutes} 分钟
                            </option>
                          ))}
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
                              disabled={busy}
                              onClick={() => approve(items)}
                            >
                              {item.risk.level === 'high' ? '检查并允许' : '允许'}
                            </button>
                            <button
                              className="btn compact"
                              disabled={busy}
                              onClick={() => respondCluster(items, 'deny')}
                            >
                              拒绝
                            </button>
                          </>
                        ) : null}
                        <button
                          className="btn subtle compact"
                          disabled={busy}
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
