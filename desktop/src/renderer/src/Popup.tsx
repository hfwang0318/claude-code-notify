import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppState,
  ApprovalItem,
  CompletionNotice as CompletionNoticeInfo,
  SkippedApproval
} from '../../shared/types'
import {
  approvalCommand,
  diffStat,
  extractEditDiffs,
  groupBySession,
  planText,
  prettyToolInput,
  remainingSeconds,
  riskLabel,
  riskSegments,
  sessionColor,
  sessionInitials,
  shortPath,
  shortSessionId,
  slackSeconds,
  sortForTriage,
  URGENT_SECONDS
} from '../../shared/session'
import { estimateHandlingMs } from '../../shared/analytics'
import {
  describeSuggestion,
  isKnownSuggestionType,
  suggestionNeedsConfirmation
} from '../../shared/suggestions'
import {
  clusterApprovals,
  clusterFor,
  crossSessionClusters
} from '../../shared/approvals'
import {
  buildAnswers,
  nextUnansweredIndex,
  validateDrafts,
  withOtherToggled,
  type QuestionDraft
} from '../../shared/questions'
import { api } from './api'
import { formatTime } from './format'

function emptyDrafts(item: ApprovalItem): QuestionDraft[] {
  return item.questions.map(() => ({ selected: [], text: '', other: false }))
}

function CompletionNotice({
  notice,
  platform,
  onDismiss
}: {
  notice: CompletionNoticeInfo
  platform: string
  onDismiss: () => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLElement>(null)
  const padding = platform === 'win32' ? 8 : 18

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const observer = new ResizeObserver(() => {
      api.resizePopup(Math.ceil(card.scrollHeight + padding * 2))
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [notice.id, padding])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return
      event.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onDismiss])

  return (
    <div className="popup-stage" data-platform={platform}>
      <section
        ref={cardRef}
        className="popup-card notice-card"
        role="status"
        aria-live="polite"
        tabIndex={-1}
      >
        <div className="popup-drag" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <button
          className="popup-close"
          onClick={onDismiss}
          aria-label="关闭完成提醒"
          title="关闭"
        >
          ×
        </button>
        <header className="popup-head">
          <span className="popup-kicker">已完成</span>
          <span className="popup-time">{formatTime(notice.createdAt)}</span>
        </header>
        <h1 className="popup-title">{notice.title}</h1>
        {notice.shortId || notice.branch ? (
          <div className="notice-meta">
            {notice.shortId ? <span className="identity-id">#{notice.shortId}</span> : null}
            {notice.branch ? <span className="identity-branch">{notice.branch}</span> : null}
          </div>
        ) : null}
        {notice.task ? (
          <div className="identity-task notice-task" title={notice.task}>
            <span className="identity-task-label">任务</span>
            <span className="identity-task-text">{notice.task}</span>
          </div>
        ) : null}
        <p className="popup-sub notice-body">{notice.body}</p>
        <div className="popup-actions inline">
          <button className="popup-btn allow" onClick={onDismiss}>
            知道了
          </button>
        </div>
        <div className="popup-foot">7 秒后自动关闭 · Enter / Esc 关闭</div>
      </section>
    </div>
  )
}

function ExpiredPanel({
  items,
  colorFor,
  titleFor,
  onClose,
  onAck,
  onAckAll
}: {
  items: ApprovalItem[]
  colorFor: (key: string) => string
  titleFor: (key: string, fallback: string) => string
  onClose: () => void
  onAck: (id: string) => void
  onAckAll: () => void
}): React.JSX.Element {
  return (
    <div className="popup-panel">
      <div className="popup-panel-head">
        <b>回退记录</b>
        <span>{items.length} 条超时未处理</span>
        <button className="link" onClick={onClose}>
          返回审批
        </button>
      </div>
      <p className="popup-panel-hint">
        超时后由终端继续询问，不等于自动允许；终端不在前台时任务会停在那里。
      </p>
      <div className="expired-list">
        {items.map((entry) => (
          <div className="expired-row" key={entry.id}>
            <span
              className="session-dot"
              style={{ background: colorFor(entry.sessionKey) }}
              aria-hidden="true"
            />
            <div className="expired-copy">
              <b>{titleFor(entry.sessionKey, entry.sessionLabel)}</b>
              <span>
                {entry.task ? `${entry.task} · ` : ''}
                {entry.tool} · {(approvalCommand(entry) || entry.message).slice(0, 90)}
              </span>
            </div>
            <time>{formatTime(entry.createdAt)}</time>
            <button className="link" onClick={() => onAck(entry.id)}>
              关闭
            </button>
          </div>
        ))}
        {items.length === 0 ? <div className="popup-panel-empty">暂无回退记录</div> : null}
      </div>
      {items.length > 0 ? (
        <button className="popup-btn allow" onClick={onAckAll}>
          全部知道了
        </button>
      ) : null}
    </div>
  )
}

function SkippedPanel({
  items,
  onClose,
  onAck,
  onAckAll
}: {
  items: SkippedApproval[]
  onClose: () => void
  onAck: (id: string) => void
  onAckAll: () => void
}): React.JSX.Element {
  return (
    <div className="popup-panel">
      <div className="popup-panel-head">
        <b>队列回退记录</b>
        <span>{items.length} 条未弹出</span>
        <button className="link" onClick={onClose}>
          返回审批
        </button>
      </div>
      <p className="popup-panel-hint">
        这些请求到达时队列已满或预计来不及处理，已直接交回终端；它们不会出现在待审批里。
      </p>
      <div className="expired-list">
        {items.map((entry) => (
          <div className="expired-row" key={entry.id}>
            <span className="skipped-dot" aria-hidden="true">
              ⤺
            </span>
            <div className="expired-copy">
              <b>
                {entry.sessionLabel} · {entry.tool}
              </b>
              <span>
                {entry.reason === 'overloaded' ? '队列过载' : '预计来不及'} · 已有{' '}
                {entry.pendingGroups} 组排队 · {entry.command.slice(0, 70)}
              </span>
            </div>
            <time>{formatTime(entry.ts)}</time>
            <button className="link" onClick={() => onAck(entry.id)}>
              关闭
            </button>
          </div>
        ))}
        {items.length === 0 ? <div className="popup-panel-empty">暂无队列回退记录</div> : null}
      </div>
      {items.length > 0 ? (
        <button className="popup-btn allow" onClick={onAckAll}>
          全部知道了
        </button>
      ) : null}
    </div>
  )
}

function HelpPanel({
  modifier,
  onClose
}: {
  modifier: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="popup-panel help-panel">
      <div className="popup-panel-head">
        <b>快捷键</b>
        <span>多会话审批</span>
        <button className="link" onClick={onClose}>
          关闭
        </button>
      </div>
      <dl className="help-grid">
        <dt>Enter</dt>
        <dd>允许（高风险需再按一次）</dd>
        <dt>Esc</dt>
        <dd>交给终端；输入框内先退出输入</dd>
        <dt>{modifier}1–9</dt>
        <dd>切换等待中的会话</dd>
        <dt>{modifier}↑/↓</dt>
        <dd>切换本会话的请求</dd>
        <dt>J / K</dt>
        <dd>按处理顺序移到下一条 / 上一条</dd>
        <dt>A / D / T</dt>
        <dd>允许 / 拒绝 / 交给终端</dd>
        <dt>P / S</dt>
        <dd>暂停或恢复本组倒计时 / 5 分钟后再提醒</dd>
        <dt>1–9</dt>
        <dd>选择当前请求的选项或当前问题的选项</dd>
        <dt>?</dt>
        <dd>显示或关闭这份帮助</dd>
      </dl>
      <p className="popup-panel-hint">
        合并的相同请求会作为一组一起决策；收起弹窗不会放弃审批，超时前 15 秒会重新出现。
      </p>
    </div>
  )
}

export default function Popup(): React.JSX.Element | null {  const [state, setState] = useState<AppState | null>(null)
  const [now, setNow] = useState(Date.now())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft[]>>({})
  const [answerErrors, setAnswerErrors] = useState<number[]>([])
  const [activeQuestion, setActiveQuestion] = useState(0)
  const [showQueue, setShowQueue] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [confirmHighRisk, setConfirmHighRisk] = useState(false)
  const [denyOpen, setDenyOpen] = useState(false)
  const [denyReason, setDenyReason] = useState('')
  const [suggestionConfirm, setSuggestionConfirm] = useState<number | null>(null)
  const [ruleTtl, setRuleTtl] = useState<'1h' | '24h' | 'forever'>('forever')
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [preferredSession, setPreferredSession] = useState<string | null>(null)
  const [expiredOpen, setExpiredOpen] = useState(false)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [queueQuery, setQueueQuery] = useState('')
  const [queueRisk, setQueueRisk] = useState<'all' | 'high' | 'question'>('all')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [ruleScope, setRuleScope] = useState<'session' | 'project'>('session')
  const [crossConfirm, setCrossConfirm] = useState(false)
  const [expandedDiffs, setExpandedDiffs] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const armedAt = useRef(Date.now())
  const receiptTimer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    void api.getState().then((next) => {
      if (alive) setState(next)
    })
    const offState = api.onState((next) => setState(next))
    const offSelect = api.onSelectApproval((id) => {
      setSelectedId(id)
      setShowQueue(false)
    })
    return () => {
      alive = false
      offState()
      offSelect()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  const pending = useMemo(
    () =>
      state
        ? sortForTriage(
            state.pending.filter(
              (entry) => !entry.snoozedUntil || entry.snoozedUntil <= now
            )
          )
        : [],
    [state?.pending, now]
  )
  const snoozedCount = useMemo(
    () =>
      state
        ? state.pending.filter(
            (entry) => entry.snoozedUntil && entry.snoozedUntil > now
          ).length
        : 0,
    [state?.pending, now]
  )
  const selected = useMemo(() => {
    if (!state) return null
    if (selectedId) {
      const found = pending.find((entry) => entry.id === selectedId)
      if (found) return found
    }
    // Sticky session: once the user picks a session, stay in it. Another
    // session only preempts when it is genuinely about to expire.
    const urgentOther = pending.find(
      (entry) =>
        entry.sessionKey !== preferredSession &&
        !entry.paused &&
        remainingSeconds(entry.timeoutAt, now) <= 10
    )
    if (preferredSession) {
      const first = pending.find((entry) => entry.sessionKey === preferredSession)
      if (first) {
        if (urgentOther && remainingSeconds(first.timeoutAt, now) > URGENT_SECONDS) {
          return urgentOther
        }
        return first
      }
    }
    return urgentOther || pending[0] || null
  }, [pending, selectedId, preferredSession, state, now])
  const expired = selected ? null : state?.expired[0] || null
  const item = selected || expired
  const isExpired = Boolean(expired && !selected)
  const allClusters = useMemo(
    () => (state ? clusterApprovals(state.pending) : []),
    [state?.pending]
  )
  const pendingGroups = useMemo(() => clusterApprovals(pending), [pending])
  const actionItems = useMemo(
    () => (item && !isExpired ? clusterFor(allClusters, item.id) : []),
    [allClusters, item?.id, isExpired]
  )
  const colorFor = (key: string): string =>
    state?.sessions.find((session) => session.key === key)?.color || sessionColor(key)
  const titleFor = (key: string, fallback: string): string =>
    state?.sessions.find((session) => session.key === key)?.title || fallback
  const identityTitle = item
    ? titleFor(item.sessionKey, item.sessionLabel)
    : ''

  useEffect(() => {
    if (!item) return
    armedAt.current = Date.now()
    setDetailsOpen(false)
    setConfirmHighRisk(false)
    setDenyOpen(false)
    setDenyReason('')
    setSuggestionConfirm(null)
    setAnswerErrors([])
    setActiveQuestion(0)
    setRenaming(false)
    setNameDraft('')
    setCrossConfirm(false)
    setExpandedDiffs(false)
    setDrafts((current) => {
      if (current[item.id]) return current
      return { ...current, [item.id]: emptyDrafts(item) }
    })
  }, [item?.id])

  useEffect(() => {
    if (!selected || !preferredSession) return
    if (pending.some((entry) => entry.sessionKey === preferredSession)) return
    setPreferredSession(selected.sessionKey)
  }, [pending, preferredSession, selected])

  useEffect(() => {
    if (!showQueue) return
    const timer = window.setTimeout(() => {
      const body = cardRef.current?.querySelector<HTMLElement>('.popup-body')
      if (body) body.scrollTop = body.scrollHeight
      cardRef.current
        ?.querySelector<HTMLElement>('.queue-row.active')
        ?.scrollIntoView({ block: 'nearest' })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [showQueue, selectedId])

  useEffect(() => {
    if (!helpOpen && !expiredOpen && !skippedOpen) return
    const body = cardRef.current?.querySelector<HTMLElement>('.popup-body')
    if (body) body.scrollTop = 0
  }, [helpOpen, expiredOpen, skippedOpen])

  useEffect(
    () => () => {
      if (receiptTimer.current) window.clearTimeout(receiptTimer.current)
    },
    []
  )

  const popupPadding = state?.app.platform === 'win32' ? 8 : 18

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const observer = new ResizeObserver(() => {
      const body = card.querySelector<HTMLElement>('.popup-body')
      if (!body) {
        api.resizePopup(Math.ceil(card.scrollHeight + popupPadding * 2))
        return
      }
      // The body scrolls, so card.scrollHeight stops at the current window
      // height. Measure the body's content instead; otherwise the window
      // shrinks until the body collapses and the content never gets room.
      const chrome = card.scrollHeight - body.clientHeight
      const content = Math.min(body.scrollHeight, 440)
      api.resizePopup(Math.ceil(chrome + content + popupPadding * 2))
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [
    item?.id,
    detailsOpen,
    showQueue,
    denyOpen,
    suggestionConfirm,
    expiredOpen,
    skippedOpen,
    helpOpen,
    expandedDiffs,
    crossConfirm,
    popupPadding
  ])

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    window.setTimeout(() => card.focus(), 30)
  }, [item?.id])

  const remaining =
    item && !isExpired
      ? item.paused
        ? Math.max(0, Math.ceil((item.pausedRemainingMs || 0) / 1000))
        : remainingSeconds(item.timeoutAt, now)
      : 0
  const total = Math.max(1, item?.timeoutSec || 1)
  const progress = Math.max(0, Math.min(1, remaining / total))
  const draft = item ? drafts[item.id] || emptyDrafts(item) : []
  const questionMode = item?.kind === 'question' && !isExpired
  const highRisk = item?.risk.level === 'high'
  const command = item ? approvalCommand(item) : ''
  const diffs = item && !questionMode ? extractEditDiffs(item.toolInput) : []
  const plan = item && item.tool === 'ExitPlanMode' ? planText(item.toolInput) : ''
  const canRememberRule =
    item &&
    !questionMode &&
    !highRisk &&
    Boolean(command) &&
    item.tool !== 'AskUserQuestion'
  const duplicateCount = actionItems.length
  const allPaused = pending.length > 0 && pending.every((entry) => entry.paused)
  const estimateMs = item
    ? estimateHandlingMs(state?.history || [], item.tool, item.risk.level)
    : 0
  const slack = item && !isExpired ? slackSeconds(remaining, estimateMs) : 0
  const diffSummary = diffStat(diffs)
  const sameSessionItems = item
    ? pending.filter((entry) => entry.sessionKey === item.sessionKey)
    : []
  const lastForSession = sameSessionItems.length === 1
  const crossGroup =
    item && !questionMode && !highRisk
      ? crossSessionClusters(pending).find((group) =>
          group.items.some((entry) => entry.id === item.id)
        )
      : undefined
  const crossOthers = crossGroup
    ? crossGroup.items.filter((entry) => entry.sessionKey !== item?.sessionKey)
    : []
  const allowCount = item
    ? (state?.history || []).filter(
        (record) =>
          record.tool === item.tool &&
          record.decision === 'allow' &&
          record.command.trim() === command.trim()
      ).length
    : 0
  const suggestRule = Boolean(
    canRememberRule &&
      allowCount >= 2 &&
      !(state?.rules || []).some(
        (rule) =>
          rule.enabled &&
          rule.tool === item?.tool &&
          rule.pattern.trim() === command.trim()
      )
  )

  const waitingSessions = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string
        title: string
        task: string
        color: string
        origin: string
        items: ApprovalItem[]
        pausedCount: number
        earliest: number
      }
    >()
    for (const entry of pending) {
      const session = state?.sessions.find((candidate) => candidate.key === entry.sessionKey)
      const existing = groups.get(entry.sessionKey)
      if (existing) {
        existing.items.push(entry)
        if (entry.paused) existing.pausedCount += 1
        else existing.earliest = Math.min(existing.earliest, entry.timeoutAt)
      } else {
        groups.set(entry.sessionKey, {
          key: entry.sessionKey,
          title: session?.title || entry.sessionLabel,
          task: session?.task || entry.task || '',
          color: session?.color || sessionColor(entry.sessionKey),
          origin: session?.origin || entry.origin,
          items: [entry],
          pausedCount: entry.paused ? 1 : 0,
          earliest: entry.paused ? Number.POSITIVE_INFINITY : entry.timeoutAt
        })
      }
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        // One badge unit = one decision, not one HTTP request.
        count: clusterApprovals(group.items).length,
        paused: group.pausedCount === group.items.length,
        hasHigh: group.items.some((entry) => entry.risk.level === 'high'),
        hasQuestion: group.items.some((entry) => entry.kind === 'question'),
        firstId: group.items[0]?.id || ''
      }))
      .sort((left, right) => {
        if (left.paused !== right.paused) return left.paused ? 1 : -1
        return left.earliest - right.earliest
      })
  }, [pending, state?.sessions])

  const stripSessions = useMemo(() => {
    if (waitingSessions.length <= 3) return waitingSessions
    const first = waitingSessions.slice(0, 2)
    const active = waitingSessions.find((session) => session.key === item?.sessionKey)
    if (active && !first.some((session) => session.key === active.key)) {
      return [...first, active]
    }
    return waitingSessions.slice(0, 3)
  }, [waitingSessions, item?.sessionKey])

  const pushReceipt = (text: string): void => {
    setReceipt(text)
    if (receiptTimer.current) window.clearTimeout(receiptTimer.current)
    receiptTimer.current = window.setTimeout(() => setReceipt(null), 2400)
  }

  const applyDecision = async (
    ids: string[],
    decision: string,
    extra?: { reason?: string; answers?: ReturnType<typeof buildAnswers>; index?: number },
    receiptText?: string
  ): Promise<void> => {
    if (ids.length === 0 || busy) return
    setBusy(true)
    try {
      if (ids.length === 1) await api.respond(ids[0], decision, extra)
      else await api.respondMany(ids, decision, extra)
      if (receiptText) pushReceipt(receiptText)
    } finally {
      setBusy(false)
    }
  }

  const submitAnswers = (): void => {
    if (!item || busy) return
    const invalid = validateDrafts(item.questions, draft)
    if (invalid.length > 0) {
      setAnswerErrors(invalid)
      setActiveQuestion(invalid[0])
      const target = cardRef.current?.querySelector<HTMLElement>(
        `[data-question-index="${invalid[0]}"]`
      )
      target?.focus()
      target?.scrollIntoView({ block: 'nearest' })
      return
    }
    setAnswerErrors([])
    const count = item.questions.length
    void applyDecision(
      [item.id],
      'answer',
      { answers: buildAnswers(item.questions, draft) },
      `已提交 ${count} 个回答 · ${identityTitle}`
    )
  }

  const focusQuestion = (index: number): void => {
    setActiveQuestion(index)
    window.setTimeout(() => {
      const target = cardRef.current?.querySelector<HTMLElement>(
        `[data-question-index="${index}"]`
      )
      target?.focus()
      target?.scrollIntoView({ block: 'nearest' })
    }, 0)
  }

  const advanceQuestion = (): void => {
    if (!item) return
    const next = nextUnansweredIndex(item.questions, draft, activeQuestion)
    if (next >= 0) {
      setAnswerErrors(validateDrafts(item.questions, draft))
      focusQuestion(next)
      return
    }
    submitAnswers()
  }

  const respondGroup = (decision: string, extra?: { reason?: string }): void => {
    if (!item) return
    const ids = actionItems.length > 0 ? actionItems.map((entry) => entry.id) : [item.id]
    const label =
      decision === 'allow'
        ? '已允许'
        : decision === 'deny'
          ? '已拒绝'
          : '已交给终端'
    void applyDecision(
      ids,
      decision,
      extra,
      `${label} · ${item.tool}${ids.length > 1 ? ` ×${ids.length}` : ''} · ${identityTitle}`
    )
  }

  const allow = (): void => {
    if (!item || busy) return
    const allowOption = item.options.find((option) => option.id === 'allow')
    if (!allowOption) return
    if (highRisk && state?.prefs.enterConfirmsHighRisk && !confirmHighRisk) {
      setConfirmHighRisk(true)
      return
    }
    respondGroup(allowOption.id)
  }

  const ask = (): void => {
    if (!item || busy) return
    respondGroup('ask')
  }

  const submitDeny = (withReason: boolean): void => {
    if (!item || busy) return
    const reason = withReason ? denyReason.trim().slice(0, 2000) : ''
    respondGroup('deny', reason ? { reason } : undefined)
  }

  const snoozeGroup = (minutes: number): void => {
    if (!item) return
    if (remaining <= minutes * 60) {
      pushReceipt(`剩余 ${remaining}s，${minutes} 分钟后提醒会直接超时`)
      return
    }
    const ids = actionItems.length > 0 ? actionItems.map((entry) => entry.id) : [item.id]
    for (const id of ids) void api.snoozeApproval(id, minutes)
    pushReceipt(`已稍后 ${minutes} 分钟 · 倒计时继续`)
  }

  const togglePause = (): void => {
    if (!item || isExpired) return
    const next = !item.paused
    const ids = actionItems.length > 0 ? actionItems.map((entry) => entry.id) : [item.id]
    // A merged card is one decision: pause every request behind it, not just
    // the representative. Otherwise siblings keep counting down invisibly.
    for (const id of ids) void api.pauseApproval(id, next)
    pushReceipt(next ? '本组倒计时已暂停' : '本组倒计时已恢复')
  }

  const acknowledge = (id?: string): void => {
    void api.acknowledgeExpired(id)
  }

  const acknowledgeSkipped = (id?: string): void => {
    void api.clearSkipped(id)
  }

  const submitExpired = (): void => {
    acknowledge()
    setExpiredOpen(false)
  }

  const selectItem = (id: string, sessionKey: string, keepQueue = false): void => {
    setSelectedId(id)
    setPreferredSession(sessionKey)
    if (!keepQueue) setShowQueue(false)
  }

  const toggleOption = (index: number, label: string, multi: boolean): void => {
    if (!item) return
    setActiveQuestion(index)
    setAnswerErrors((current) => current.filter((entry) => entry !== index))
    const current = drafts[item.id] || emptyDrafts(item)
    setDrafts({
      ...drafts,
      [item.id]: current.map((entry, entryIndex) => {
        if (entryIndex !== index) return entry
        if (multi) {
          const selected = entry.selected.includes(label)
            ? entry.selected.filter((value) => value !== label)
            : [...entry.selected, label]
          return { ...entry, selected }
        }
        return { ...entry, selected: [label] }
      })
    })
  }

  const updateText = (index: number, text: string): void => {
    if (!item) return
    setActiveQuestion(index)
    setAnswerErrors((current) => current.filter((entry) => entry !== index))
    const current = drafts[item.id] || emptyDrafts(item)
    setDrafts({
      ...drafts,
      [item.id]: current.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, text } : entry
      )
    })
  }

  const toggleOther = (index: number): void => {
    if (!item) return
    setActiveQuestion(index)
    setAnswerErrors((current) => current.filter((entry) => entry !== index))
    const current = drafts[item.id] || emptyDrafts(item)
    setDrafts({
      ...drafts,
      [item.id]: current.map((entry, entryIndex) =>
        entryIndex === index ? withOtherToggled(entry) : entry
      )
    })
  }

  const rememberRule = (): void => {
    if (!item) return
    const expiresAt =
      ruleTtl === '1h'
        ? Date.now() + 60 * 60 * 1000
        : ruleTtl === '24h'
          ? Date.now() + 24 * 60 * 60 * 1000
          : undefined
    void api.addRule({
      scope: ruleScope,
      tool: item.tool,
      pattern: command,
      project: ruleScope === 'project' ? item.project : undefined,
      sessionKey: ruleScope === 'session' ? item.sessionKey : undefined,
      origin: item.origin,
      ...(expiresAt ? { expiresAt } : {})
    })
    pushReceipt(
      `规则已保存 · ${ruleScope === 'session' ? '仅本会话' : '本项目'} · ${
        ruleTtl === '1h' ? '1 小时' : ruleTtl === '24h' ? '24 小时' : '永久'
      }`
    )
  }

  const copyDetail = (): void => {
    if (!item) return
    let text = command
    if (detailsOpen) text = prettyToolInput(item.toolInput)
    else if (plan) text = plan
    else if (diffs.length > 0) {
      text = diffs
        .map(
          (diff) =>
            `${diff.filePath}\n${diff.oldText
              .split('\n')
              .map((line: string) => `- ${line}`)
              .join('\n')}\n${diff.newText
              .split('\n')
              .map((line: string) => `+ ${line}`)
              .join('\n')}`
        )
        .join('\n\n')
    }
    void api.copy(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  useEffect(() => {
    if (!item) return
    const focusQuestion = (index: number): void => {
      setActiveQuestion(index)
      window.setTimeout(() => {
        const target = cardRef.current?.querySelector<HTMLElement>(
          `[data-question-index="${index}"]`
        )
        target?.focus()
        target?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }
    const move = (delta: number): void => {
      if (pending.length === 0) return
      const index = Math.max(
        0,
        pending.findIndex((entry) => entry.id === item.id)
      )
      const next = pending[(index + delta + pending.length) % pending.length]
      if (!next) return
      setSelectedId(next.id)
      setPreferredSession(next.sessionKey)
    }
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(
        target?.tagName === 'INPUT' ||
          target?.tagName === 'TEXTAREA' ||
          target?.isContentEditable
      )
      const switchModifier = state?.app.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (event.key === 'Escape') {
        if (typing) {
          // 输入框内的 Esc 先退出输入，不提交“交给终端”；再按一次才交给终端。
          event.preventDefault()
          target?.blur()
          return
        }
        if (helpOpen) {
          event.preventDefault()
          setHelpOpen(false)
          return
        }
        if (expiredOpen) {
          event.preventDefault()
          setExpiredOpen(false)
          return
        }
        if (skippedOpen) {
          event.preventDefault()
          setSkippedOpen(false)
          return
        }
        if (showQueue) {
          event.preventDefault()
          setShowQueue(false)
          return
        }
        if (isExpired) {
          event.preventDefault()
          submitExpired()
          return
        }
        if (Date.now() - armedAt.current < 500) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        ask()
        return
      }
      if (isExpired) {
        if (event.key === 'Enter') {
          event.preventDefault()
          submitExpired()
        }
        return
      }
      if (event.key === 'Tab') {
        const card = cardRef.current
        if (!card) return
        const focusables = Array.from(
          card.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((element) => element.offsetParent !== null)
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      // 跨会话 / 同会话切换必须支持键盘，才配得上“多会话”这个能力。
      if (switchModifier && /^[1-9]$/.test(event.key)) {
        const session = waitingSessions[Number(event.key) - 1]
        const first = session
          ? pending.find((entry) => entry.sessionKey === session.key)
          : undefined
        if (first) {
          event.preventDefault()
          selectItem(first.id, first.sessionKey, true)
        }
        return
      }
      if (switchModifier && item.kind === 'question' && /^Arrow(Left|Right)$/.test(event.key)) {
        event.preventDefault()
        const offset = event.key === 'ArrowRight' ? 1 : -1
        const next =
          (activeQuestion + offset + item.questions.length) % item.questions.length
        focusQuestion(next)
        return
      }
      if (
        switchModifier &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        item
      ) {
        const sameSession = pending.filter((entry) => entry.sessionKey === item.sessionKey)
        if (sameSession.length > 1) {
          event.preventDefault()
          const index = sameSession.findIndex((entry) => entry.id === item.id)
          const offset = event.key === 'ArrowDown' ? 1 : -1
          const next = sameSession[(index + offset + sameSession.length) % sameSession.length]
          if (next) {
            setSelectedId(next.id)
            setPreferredSession(next.sessionKey)
          }
        }
        return
      }
      if (event.key === '?' && !typing) {
        event.preventDefault()
        setHelpOpen((value) => !value)
        return
      }
      if (typing) return
      if (target?.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) {
        return
      }
      // The popup can steal focus while the user is typing in a terminal. The
      // first 500ms of a card must not turn an in-flight keystroke into a
      // decision (Enter) or a shortcut (A/D/T/S/P).
      if (Date.now() - armedAt.current < 500) return
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault()
        move(1)
        return
      }
      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault()
        move(-1)
        return
      }
      if (event.key === 'a' || event.key === 'A') {
        if (item.kind === 'permission') {
          event.preventDefault()
          allow()
        }
        return
      }
      if (event.key === 'd' || event.key === 'D') {
        if (item.kind === 'permission') {
          event.preventDefault()
          setDenyOpen(true)
        }
        return
      }
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        ask()
        return
      }
      if (event.key === 's' || event.key === 'S') {
        event.preventDefault()
        snoozeGroup(5)
        return
      }
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        togglePause()
        return
      }
      if (item.kind === 'question') {
        if (/^[1-9]$/.test(event.key)) {
          const questionIndex =
            activeQuestion >= 0 && activeQuestion < item.questions.length
              ? activeQuestion
              : 0
          const question = item.questions[questionIndex]
          const option = question?.options[Number(event.key) - 1]
          if (question && option) {
            event.preventDefault()
            toggleOption(questionIndex, option.label, Boolean(question.multiSelect))
          }
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const next = nextUnansweredIndex(item.questions, draft, activeQuestion)
          if (next >= 0) {
            setAnswerErrors(validateDrafts(item.questions, draft))
            focusQuestion(next)
            return
          }
          submitAnswers()
        }
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        allow()
        return
      }
      if (/^[1-9]$/.test(event.key)) {
        const option = item.options[Number(event.key) - 1]
        if (!option) return
        event.preventDefault()
        if (option.id === 'allow') allow()
        else if (option.id === 'deny') setDenyOpen(true)
        else respondGroup(option.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    item,
    isExpired,
    highRisk,
    confirmHighRisk,
    draft,
    state,
    activeQuestion,
    pending,
    waitingSessions,
    helpOpen,
    expiredOpen,
    skippedOpen,
    showQueue,
    busy
  ])

  if (!state) return null
  if (!item) {
    return state.notice ? (
      <CompletionNotice
        notice={state.notice}
        platform={state.app.platform}
        onDismiss={() => void api.dismissNotice()}
      />
    ) : null
  }

  const queue = pending.filter((entry) => entry.id !== item.id)
  const urgentQueued = queue
    .filter(
      (entry) => !entry.paused && remainingSeconds(entry.timeoutAt, now) <= URGENT_SECONDS
    )
    .sort((left, right) => left.timeoutAt - right.timeoutAt)[0]
  const selectedSession = state.sessions.find((session) => session.key === item.sessionKey)
  const muted = (selectedSession?.mutedUntil || 0) > now

  const identity = {
    title: selectedSession?.title || item.sessionLabel,
    shortId: selectedSession?.shortId || shortSessionId(item.sessionId),
    task: selectedSession?.task || item.task || '',
    branch: selectedSession?.branch || item.branch || '',
    color: selectedSession?.color || colorFor(item.sessionKey),
    customLabel: selectedSession?.customLabel || false,
    project: selectedSession?.project || item.project,
    origin: selectedSession?.origin || item.origin,
    terminal: selectedSession?.terminal || item.terminal,
    tty: selectedSession?.tty || item.tty,
    cwd: selectedSession?.cwd || item.cwd
  }
  const initials = sessionInitials({ project: identity.project, label: identity.title })
  const sourceLine = [
    identity.origin,
    identity.terminal || identity.tty,
    identity.branch
  ]
    .filter(Boolean)
    .join(' · ')
  const identityPath = shortPath(identity.cwd)
  const sessionPosition = waitingSessions.findIndex(
    (session) => session.key === item.sessionKey
  )
  const requestPosition = sameSessionItems.findIndex((entry) => entry.id === item.id)
  const switchModifierLabel = state.app.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const queueText = queueQuery.trim().toLowerCase()
  const queueRiskMatches = (entry: ApprovalItem): boolean => {
    if (queueRisk === 'high' && entry.risk.level !== 'high') return false
    if (queueRisk === 'question' && entry.kind !== 'question') return false
    if (!queueText) return true
    const session = state.sessions.find((candidate) => candidate.key === entry.sessionKey)
    return [
      entry.sessionLabel,
      session?.title,
      session?.task,
      entry.task,
      entry.tool,
      approvalCommand(entry)
    ]
      .join(' ')
      .toLowerCase()
      .includes(queueText)
  }
  const queueGroups = groupBySession(pending.filter(queueRiskMatches)).map((group) => {
    const session = state.sessions.find((candidate) => candidate.key === group.key)
    const first = group.items[0]
    return {
      key: group.key,
      items: group.items,
      title: session?.title || first.sessionLabel,
      task: session?.task || first.task || '',
      color: session?.color || sessionColor(group.key),
      count: clusterApprovals(group.items).length
    }
  })

  const startRename = (): void => {
    setRenaming(true)
    setNameDraft(
      identity.customLabel
        ? identity.title
        : (identity.task || identity.title).slice(0, 60)
    )
  }

  const commitRename = (): void => {
    const next = nameDraft.trim()
    if (next) void api.renameSession(item.sessionKey, next)
    setRenaming(false)
    setNameDraft('')
  }

  const cancelRename = (): void => {
    setRenaming(false)
    setNameDraft('')
  }

  return (
    <div className="popup-stage" data-platform={state.app.platform}>
      <section
        ref={cardRef}
        className={`popup-card risk-${item.risk.level}`}
        style={{ '--session-color': identity.color } as React.CSSProperties}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="popup-title"
        tabIndex={-1}
      >
        <div className="popup-drag" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <button
          className="popup-close"
          onClick={() => (isExpired ? acknowledge() : void api.collapsePopup())}
          aria-label={isExpired ? '关闭回退提示' : '收起弹窗，保留待审批'}
          title={isExpired ? '关闭提示' : '收起（审批仍在队列，超时前会再出现）'}
        >
          ×
        </button>

        <header className="popup-head">
          <span className="popup-kicker">
            {isExpired
              ? '已回退终端'
              : questionMode
                ? '需要回答'
                : '需要授权'}
          </span>
          <span className="popup-time">{formatTime(item.createdAt)}</span>
          <button
            className="popup-help"
            aria-label="快捷键帮助"
            title="快捷键（?）"
            onClick={() => setHelpOpen(true)}
          >
            ?
          </button>
        </header>

        {receipt ? (
          <div className="popup-receipt" role="status" aria-live="polite">
            {receipt}
          </div>
        ) : null}

        {state.toast ? (
          <div className="popup-toast" role="status" aria-live="polite">
            {state.toast}
          </div>
        ) : null}

        {!isExpired && state.skipped.length > 0 ? (
          <div className="popup-skipped-banner">
            <span>
              队列过载：{state.skipped.length} 条请求未弹出，已直接回退终端
            </span>
            <button className="link" onClick={() => setSkippedOpen(true)}>
              查看
            </button>
            <button className="link" onClick={() => acknowledgeSkipped()}>
              知道了
            </button>
          </div>
        ) : null}

            {waitingSessions.length > 1 ? (
              <div className="session-strip" role="tablist" aria-label="等待中的会话">
                {stripSessions.map((session) => {
                  const active = session.key === item.sessionKey
                  const shortcut = waitingSessions.findIndex(
                    (entry) => entry.key === session.key
                  ) + 1
                  const left = Number.isFinite(session.earliest)
                    ? Math.max(0, Math.ceil((session.earliest - now) / 1000))
                    : 0
                  const flag = session.hasHigh
                    ? '⚠'
                    : session.hasQuestion
                      ? '?'
                      : session.origin !== '本机'
                        ? '⤴'
                        : ''
                  return (
                    <button
                      key={session.key}
                      role="tab"
                      aria-selected={active}
                      className={`session-chip ${active ? 'active' : ''}`}
                      style={{ '--session-color': session.color } as React.CSSProperties}
                      title={`${session.title}${session.task ? ` · ${session.task}` : ''} · ${session.origin} · ${switchModifierLabel}${shortcut}`}
                      onClick={() => {
                        const first = pending.find((entry) => entry.sessionKey === session.key)
                        if (first) selectItem(first.id, session.key)
                      }}
                    >
                      <i aria-hidden="true" />
                      <span className="session-chip-name">{session.title}</span>
                      {flag ? (
                        <span
                          className={`session-chip-flag ${
                            session.hasHigh
                              ? 'high'
                              : session.hasQuestion
                                ? 'question'
                                : 'remote'
                          }`}
                          aria-hidden="true"
                        >
                          {flag}
                        </span>
                      ) : null}
                      <span className="session-chip-task">
                        {session.hasHigh ? '⚠ ' : session.hasQuestion ? '? ' : ''}
                        {session.task || '暂无任务摘要'}
                      </span>
                      {session.count > 1 ? <b>{session.count}</b> : null}
                      <em className={session.paused ? 'paused' : ''}>
                        {session.paused ? '已暂停' : `${shortcut} · ${left}s`}
                      </em>
                    </button>
                  )
                })}
                {waitingSessions.length > stripSessions.length ? (
                  <button
                    className="session-chip-more"
                    onClick={() => setShowQueue(true)}
                    title="展开队列查看其余会话"
                  >
                    +{waitingSessions.length - stripSessions.length}
                  </button>
                ) : null}
              </div>
            ) : null}

        <div className="popup-body">
        {!isExpired ? (
          <div
            className="popup-identity"
            style={{ '--session-color': identity.color } as React.CSSProperties}
          >
            <span className="identity-avatar" aria-hidden="true">
              {initials}
            </span>
            <div className="identity-body">
              <div className="identity-line">
                {renaming ? (
                  <input
                    className="identity-rename"
                    value={nameDraft}
                    autoFocus
                    maxLength={60}
                    placeholder={identity.task || identity.title}
                    aria-label="会话名称"
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={cancelRename}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitRename()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelRename()
                      }
                    }}
                  />
                ) : (
                  <button
                    className="popup-session-label identity-name"
                    title={`${identity.cwd || identity.title} · 点击重命名`}
                    onClick={startRename}
                  >
                    {identity.title}
                  </button>
                )}
                {identity.shortId ? (
                  <span className="identity-id">#{identity.shortId}</span>
                ) : null}
                {identity.customLabel ? <span className="identity-pinned">已命名</span> : null}
                {muted ? <span className="popup-muted">静音提醒</span> : null}
              </div>
              <div className="identity-meta">
                <span>{sourceLine || identity.origin}</span>
                {identityPath ? (
                  <span className="identity-path" title={identity.cwd}>
                    · {identityPath}
                  </span>
                ) : null}
              </div>
              {identity.task ? (
                <div
                  className={`identity-task ${
                    identity.task === identity.title ? 'duplicate' : ''
                  }`}
                  title={identity.task}
                >
                  <span className="identity-task-label">任务</span>
                  <span className="identity-task-text">{identity.task}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <h1 className="popup-title" id="popup-title">
          {isExpired
            ? `${state.expired.length} 条审批已回退终端`
            : item.message || (questionMode ? 'Claude 想问你一个问题' : 'Claude 请求执行权限')}
        </h1>
        <p className="popup-sub">
          {isExpired
            ? '超时未处理，这些审批已由终端继续；桌面端不会再次提交决定。'
            : questionMode
              ? '选择答案后点“确认回答”；也可以交给终端继续回答。'
              : highRisk
                ? '高风险操作：请先确认完整命令，再决定是否允许。'
                : '超时未处理将自动返回终端；回退不等于自动通过。'}
        </p>

        {helpOpen ? (
          <HelpPanel
            modifier={switchModifierLabel}
            onClose={() => setHelpOpen(false)}
          />
        ) : expiredOpen ? (
          <ExpiredPanel
            items={state.expired}
            colorFor={colorFor}
            titleFor={titleFor}
            onClose={() => setExpiredOpen(false)}
            onAck={(id) => acknowledge(id)}
            onAckAll={() => submitExpired()}
          />
        ) : skippedOpen ? (
          <SkippedPanel
            items={state.skipped}
            onClose={() => setSkippedOpen(false)}
            onAck={(id) => acknowledgeSkipped(id)}
            onAckAll={() => {
              acknowledgeSkipped()
              setSkippedOpen(false)
            }}
          />
        ) : isExpired ? (
          <div className="expired-list">
            {state.expired.slice(0, 6).map((entry) => (
              <div className="expired-row" key={entry.id}>
                <span
                  className="session-dot"
                  style={{ background: colorFor(entry.sessionKey) }}
                  aria-hidden="true"
                />
                <div className="expired-copy">
                  <b>{titleFor(entry.sessionKey, entry.sessionLabel)}</b>
                  <span>
                    {entry.task ? `${entry.task} · ` : ''}
                    {entry.tool} · {approvalCommand(entry).slice(0, 90) || entry.message}
                  </span>
                </div>
                <time>{formatTime(entry.createdAt)}</time>
                <button className="link" onClick={() => acknowledge(entry.id)}>
                  关闭
                </button>
              </div>
            ))}
            {state.expired.length > 6 ? (
              <button className="link expired-more" onClick={() => setExpiredOpen(true)}>
                还有 {state.expired.length - 6} 条 · 查看全部
              </button>
            ) : null}
            <button className="popup-btn allow" onClick={submitExpired}>
              全部知道了
            </button>
          </div>
        ) : (
          <>
            {state.expired.length > 0 ? (
              <div className="popup-expired-banner">
                <span>另有 {state.expired.length} 条已回退终端</span>
                <button className="link" onClick={() => setExpiredOpen(true)}>
                  查看明细
                </button>
              </div>
            ) : null}

            <div className="popup-request-row">
              <span className="popup-chip">工具 · {item.tool}</span>
              {item.risk.level !== 'low' ? (
                <span className={`risk-chip risk-${item.risk.level}`}>
                  {riskLabel(item.risk.level)}
                </span>
              ) : null}
              <span className="popup-request-kind">
                {item.kind === 'question' ? '问答请求' : '权限请求'}
              </span>
              {duplicateCount > 1 ? (
                <span className="popup-duplicate">相同请求 ×{duplicateCount}</span>
              ) : null}
              <span
                className={`slack-chip ${slack <= 0 ? 'urgent' : slack <= 10 ? 'tight' : ''}`}
                title={`剩余 ${remaining}s，按历史估算处理约 ${Math.round(estimateMs / 1000)}s`}
              >
                余量 {slack}s
              </span>
            </div>
            {duplicateCount > 1 ? (
              <div className="popup-duplicate-note">
                这些请求的工具和参数完全一致；本次允许/拒绝/交给终端会同时处理 {duplicateCount} 条。
              </div>
            ) : null}
            {crossOthers.length > 0 ? (
              <div className="popup-cross">
                <span>
                  另有 {crossOthers.length} 个会话在等同一条命令（
                  {[...new Set(crossOthers.map((entry) => entry.origin))].join('、')}）
                </span>
                {crossConfirm ? (
                  <button
                    className="link danger-link"
                    disabled={busy}
                    onClick={() => {
                      const ids = [
                        ...(actionItems.length > 0 ? actionItems : [item]),
                        ...crossOthers
                      ].map((entry) => entry.id)
                      void applyDecision(
                        ids,
                        'allow',
                        undefined,
                        `已允许 ${ids.length} 条跨会话相同命令`
                      )
                      setCrossConfirm(false)
                    }}
                  >
                    再点一次确认全部允许
                  </button>
                ) : (
                  <button className="link" onClick={() => setCrossConfirm(true)}>
                    全部允许（{crossOthers.length + 1} 个会话）
                  </button>
                )}
              </div>
            ) : null}

            {urgentQueued ? (
              <div className="urgent-queue">
                <span>
                  “{titleFor(urgentQueued.sessionKey, urgentQueued.sessionLabel)}”的审批将在{' '}
                  {remainingSeconds(urgentQueued.timeoutAt, now)}s 后回退终端
                </span>
                <button
                  className="link"
                  onClick={() => selectItem(urgentQueued.id, urgentQueued.sessionKey)}
                >
                  切换处理
                </button>
              </div>
            ) : null}

            {questionMode ? (
              <div className="question-list">
                {item.questions.length > 1 ? (
                  <div className="question-progress">
                    问题 {Math.min(activeQuestion + 1, item.questions.length)}/
                    {item.questions.length} · Enter 下一题 · {switchModifierLabel}←/→ 切题
                  </div>
                ) : null}
                {item.questions.map((question, index) => {
                  const entry = draft[index] || { selected: [], text: '', other: false }
                  const multi = Boolean(question.multiSelect)
                  const invalid = answerErrors.includes(index)
                  return (
                    <div
                      className={`question-block ${
                        activeQuestion === index ? 'active' : ''
                      }`}
                      key={`${question.question}-${index}`}
                      data-question-index={index}
                      tabIndex={-1}
                      onClick={() => setActiveQuestion(index)}
                      onFocus={() => setActiveQuestion(index)}
                    >
                      <div className="question-head">
                        {item.questions.length > 1 ? (
                          <span className="question-index">
                            问题 {index + 1}/{item.questions.length}
                          </span>
                        ) : null}
                        {multi ? <span className="question-multi">多选</span> : null}
                      </div>
                      <div className="question-text">{question.question}</div>
                      {invalid ? (
                        <div className="question-hint question-error" role="alert">
                          {entry.other
                            ? '自定义回答不能为空，请输入内容或选择一个选项。'
                            : '请选择一个选项，或展开“其他”并输入回答。'}
                        </div>
                      ) : null}
                      {question.options.length > 0 ? (
                        <div className="question-options" role="group">
                          {question.options.map((option, optionIndex) => {
                            const selectedOption = entry.selected.includes(option.label)
                            return (
                              <button
                                key={option.label}
                                className={`question-option ${selectedOption ? 'selected' : ''} ${
                                  multi ? 'multi' : ''
                                }`}
                                aria-pressed={selectedOption}
                                onClick={() => toggleOption(index, option.label, multi)}
                              >
                                <span className="question-key">{optionIndex + 1}</span>
                                <span className="question-check" aria-hidden="true" />
                                <span className="question-copy">
                                  <span className="question-label">{option.label}</span>
                                  {option.description ? (
                                    <span className="question-desc">{option.description}</span>
                                  ) : null}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                      <button
                        className="question-other-toggle"
                        onClick={() => toggleOther(index)}
                        aria-expanded={entry.other}
                      >
                        {entry.other ? '收起自定义回答' : '其他（自己输入）…'}
                      </button>
                      {entry.other ? (
                        <input
                          className="question-input"
                          value={entry.text}
                          autoFocus
                          placeholder="输入自己的回答，Enter 下一题/提交"
                          onChange={(event) => updateText(index, event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              advanceQuestion()
                            }
                          }}
                        />
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="popup-detail-block">
                {plan ? (
                  <div className="popup-plan">
                    <div className="popup-diff-head">
                      <span className="popup-diff-path">计划内容</span>
                      <button className="link" onClick={copyDetail}>
                        {copied ? '已复制' : '复制计划'}
                      </button>
                    </div>
                    <pre>{plan}</pre>
                  </div>
                ) : null}
                {diffs.length > 0 ? (
                  <div className="popup-diffs">
                    <div className="diff-summary">
                      <span>
                        {diffSummary.files} 个文件 ·{' '}
                        <b className="diff-add">+{diffSummary.additions}</b> /{' '}
                        <b className="diff-del">−{diffSummary.deletions}</b>
                      </span>
                      <button
                        className="link"
                        onClick={() => setExpandedDiffs((value) => !value)}
                      >
                        {expandedDiffs ? '收起' : '展开全部'}
                      </button>
                    </div>
                    {diffs.map((diff, index) => {
                      const oldLines = diff.oldText ? diff.oldText.split('\n') : []
                      const newLines = diff.newText ? diff.newText.split('\n') : []
                      const limit = 12
                      const hidden =
                        !expandedDiffs &&
                        (oldLines.length > limit || newLines.length > limit)
                      const shownOld = hidden ? oldLines.slice(0, limit) : oldLines
                      const shownNew = hidden ? newLines.slice(0, limit) : newLines
                      return (
                        <div className="popup-diff" key={`${diff.filePath}-${index}`}>
                          <div className="popup-diff-head">
                            <span className="popup-diff-path">{diff.filePath}</span>
                            <span className="popup-diff-actions">
                              {diffs.length > 1 ? <em>#{index + 1}</em> : null}
                              <button
                                className="link"
                                onClick={() => void api.openFile(diff.filePath)}
                              >
                                打开文件
                              </button>
                              <button className="link" onClick={copyDetail}>
                                {copied ? '已复制' : '复制diff'}
                              </button>
                            </span>
                          </div>
                          {oldLines.length > 0 ? (
                            <pre className="diff-old">
                              {shownOld
                                .map((line: string) => `- ${line}`)
                                .join('\n')}
                            </pre>
                          ) : null}
                          {newLines.length > 0 ? (
                            <pre className="diff-new">
                              {shownNew
                                .map((line: string) => `+ ${line}`)
                                .join('\n')}
                            </pre>
                          ) : null}
                          {hidden ? (
                            <div className="diff-more">
                              已折叠{' '}
                              {Math.max(oldLines.length, newLines.length) - limit} 行，点“展开全部”查看
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : plan ? null : (
                  <pre className="popup-command-block" title={command}>
                    {riskSegments(command).map((segment, index) =>
                      segment.danger ? (
                        <mark key={index}>{segment.text}</mark>
                      ) : (
                        <span key={index}>{segment.text}</span>
                      )
                    )}
                  </pre>
                )}
                <div className="popup-detail-tools">
                  <button
                    className="link"
                    onClick={() => setDetailsOpen((value) => !value)}
                    aria-expanded={detailsOpen}
                  >
                    {detailsOpen ? '收起完整参数' : '查看完整参数'}
                  </button>
                  <button className="link" onClick={copyDetail}>
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
                {detailsOpen ? (
                  <pre className="popup-detail-full">{prettyToolInput(item.toolInput)}</pre>
                ) : null}
              </div>
            )}

            {highRisk ? (
              <div className="risk-banner">
                <b>{riskLabel(item.risk.level)}</b>
                <span>{item.risk.reasons.join(' · ') || '此操作可能造成不可逆影响'}</span>
              </div>
            ) : null}
            {item.correlation === 'unmatched' ? (
              <div className="warn-banner">
                未能与终端事件关联；如果在终端处理，弹窗可能不会自动关闭。
              </div>
            ) : null}

            {!isExpired ? (
              <div className="popup-snooze">
                <span>稍后提醒</span>
                {[1, 5, 15].map((minutes) => {
                  const tooLate = remaining <= minutes * 60
                  return (
                    <button
                      key={minutes}
                      className="link"
                      disabled={tooLate}
                      onClick={() => snoozeGroup(minutes)}
                      title={
                        tooLate
                          ? `剩余 ${remaining}s，此时稍后会在超时后才提醒`
                          : `${minutes} 分钟后重新弹出，倒计时继续`
                      }
                    >
                      {minutes} 分钟
                    </button>
                  )
                })}
              </div>
            ) : null}

            {item.suggestions.length > 0 ? (
              <div className="popup-suggestions">
                <div className="popup-suggestions-title">权限建议</div>
                {item.suggestions.map((suggestion, index) => {
                  const known = isKnownSuggestionType(suggestion)
                  const dangerous = suggestionNeedsConfirmation(suggestion)
                  const confirming = suggestionConfirm === index
                  return (
                    <button
                      key={`${describeSuggestion(suggestion)}-${index}`}
                      className={`popup-btn suggestion ${confirming ? 'confirm' : ''}`}
                      disabled={!known || busy}
                      title={
                        known
                          ? JSON.stringify(suggestion, null, 2)
                          : '未知建议类型，请交给终端处理'
                      }
                      onClick={() => {
                        if (!known) return
                        if (dangerous && !confirming) {
                          setSuggestionConfirm(index)
                          return
                        }
                        setSuggestionConfirm(null)
                        void applyDecision(
                          [item.id],
                          'suggestion',
                          { index },
                          `已应用权限建议 · ${item.tool}`
                        )
                      }}
                    >
                      {confirming ? '再点一次确认：' : ''}
                      {describeSuggestion(suggestion)}
                      {!known ? '（未知类型，请交给终端）' : ''}
                    </button>
                  )
                })}
              </div>
            ) : null}

            {suggestRule ? (
              <div className="rule-suggestion">
                <span>这条命令已连续允许 {allowCount} 次，可以固化成规则。</span>
                <button className="link" onClick={rememberRule}>
                  使用当前设置保存
                </button>
              </div>
            ) : null}

            {canRememberRule ? (
              <div className="popup-remember-block">
                <div className="popup-remember-row">
                  <select
                    className="popup-rule-ttl"
                    value={ruleScope}
                    onChange={(event) =>
                      setRuleScope(event.target.value as 'session' | 'project')
                    }
                    aria-label="规则范围"
                    title="规则范围"
                  >
                    <option value="session">仅本会话</option>
                    <option value="project">本项目</option>
                  </select>
                  <select
                    className="popup-rule-ttl"
                    value={ruleTtl}
                    onChange={(event) =>
                      setRuleTtl(event.target.value as '1h' | '24h' | 'forever')
                    }
                    aria-label="规则有效期"
                    title="规则有效期"
                  >
                    <option value="1h">1 小时</option>
                    <option value="24h">24 小时</option>
                    <option value="forever">永久</option>
                  </select>
                  <button className="popup-remember" disabled={busy} onClick={rememberRule}>
                    记住此命令
                  </button>
                </div>
                <div className="rule-preview">
                  匹配：{item.tool} · 精确“{command.slice(0, 48)}” ·{' '}
                  {ruleScope === 'session'
                    ? `仅 ${identityTitle}`
                    : `项目 ${item.project}`}{' '}
                  · {ruleScope === 'session' ? item.origin : identity.origin} ·{' '}
                  {ruleTtl === '1h' ? '1 小时' : ruleTtl === '24h' ? '24 小时' : '永久'}
                </div>
              </div>
            ) : null}

            <div className="popup-queue-row">
              {waitingSessions.length > 1 ? (
                <span className="popup-position">
                  会话 {sessionPosition + 1}/{waitingSessions.length}
                  {sameSessionItems.length > 1
                    ? ` · 本会话 ${requestPosition + 1}/${sameSessionItems.length}`
                    : ''}
                </span>
              ) : null}
              {pending.length > 1 || snoozedCount > 0 ? (
                <button
                  className="popup-queue-toggle"
                  onClick={() => setShowQueue((value) => !value)}
                  aria-expanded={showQueue}
                  title={`${switchModifierLabel}1–9 切换会话；${switchModifierLabel}↑/↓ 切换本会话请求`}
                >
                  {waitingSessions.length} 个会话 · {pending.length} 条待审批
                  {snoozedCount > 0 ? ` · ${snoozedCount} 条稍后` : ''}
                  {queue.length > 0 ? ` · 还有 ${queue.length} 条` : ''}
                </button>
              ) : null}
              {pending.length > 1 ? (
                <button
                  className="link"
                  onClick={() => void api.pauseAll(!allPaused)}
                  title="暂停/继续所有可见倒计时（hook 最长约多等 10 分钟）"
                >
                  {allPaused ? '继续全部' : '暂停全部'}
                </button>
              ) : null}
              <span className="popup-foot-hint">
                {waitingSessions.length > 1 ? `${switchModifierLabel}1–9 切会话 · ` : ''}
                {questionMode
                  ? '1–9 答当前题 · Enter 下一题 · Esc 交给终端'
                  : highRisk
                    ? 'Enter 二次确认 · Esc 交给终端'
                    : 'Enter 允许 · Esc 交给终端'}
                <button
                  className="link help-trigger"
                  aria-label="快捷键帮助"
                  onClick={() => setHelpOpen(true)}
                >
                  ?
                </button>
              </span>
            </div>

            {showQueue ? (
              <div className="queue-panel">
                <div className="queue-tools">
                  <input
                    className="search-input queue-search"
                    value={queueQuery}
                    placeholder="搜索命令、会话或任务…"
                    aria-label="搜索队列"
                    onChange={(event) => setQueueQuery(event.target.value)}
                  />
                  <div className="filter-chips" role="group" aria-label="队列筛选">
                    {[
                      { id: 'all' as const, label: '全部' },
                      { id: 'high' as const, label: '高风险' },
                      { id: 'question' as const, label: '问答' }
                    ].map((filter) => (
                      <button
                        key={filter.id}
                        className={queueRisk === filter.id ? 'chip active' : 'chip'}
                        aria-pressed={queueRisk === filter.id}
                        onClick={() => setQueueRisk(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="queue-list" role="list">
                {queueGroups.map((group) => (
                  <div className="queue-group" key={group.key}>
                    <div className="queue-group-head">
                      <i
                        className="session-dot"
                        style={{ background: group.color }}
                        aria-hidden="true"
                      />
                      <b>{group.title}</b>
                      <span className="queue-group-task">{group.task || '暂无任务摘要'}</span>
                      <em>{group.count} 组</em>
                    </div>
                    {group.items.map((entry) => {
                      const paused = Boolean(entry.paused)
                      const left = paused ? 0 : remainingSeconds(entry.timeoutAt, now)
                      const active = entry.id === item.id
                      const command = approvalCommand(entry) || entry.message
                      const estimate = estimateHandlingMs(
                        state.history,
                        entry.tool,
                        entry.risk.level
                      )
                      const entrySlack = paused
                        ? 0
                        : slackSeconds(left, estimate)
                      return (
                        <button
                          key={entry.id}
                          role="listitem"
                          className={`queue-row ${active ? 'active' : ''} ${
                            !paused && (entrySlack <= 0 || left <= URGENT_SECONDS)
                              ? 'urgent'
                              : ''
                          }`}
                          title={`剩余 ${left}s · 余量 ${entrySlack}s`}
                          onClick={() => selectItem(entry.id, entry.sessionKey, true)}
                        >
                          <span className="queue-tool">
                            {entry.risk.level === 'high' ? '⚠ ' : ''}
                            {entry.tool}
                          </span>
                          <span className="queue-command" title={command}>
                            {command}
                          </span>
                          <span className={`queue-time ${paused ? 'paused' : ''}`}>
                            {paused ? '已暂停' : `${left}s`}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
                {queueGroups.length === 0 ? (
                  <div className="queue-empty">没有匹配的请求</div>
                ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}

        </div>

        {!isExpired && !expiredOpen && !skippedOpen && !helpOpen ? (
            <div className="popup-action-dock">
            <div className={`popup-count ${item.paused ? 'paused' : ''}`}>
              <div
                className="popup-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <b
                className={`${
                  (slack <= 0 || remaining <= URGENT_SECONDS) && !item.paused
                    ? 'urgent'
                    : ''
                } ${item.paused ? 'paused' : ''}`}
                title={`按历史估算处理约 ${Math.round(estimateMs / 1000)}s`}
              >
                {item.paused ? `已暂停 · ${remaining}s` : `${remaining}s`}
              </b>
              <button
                type="button"
                className={`popup-pause ${item.paused ? 'active' : ''}`}
                onClick={togglePause}
                aria-pressed={Boolean(item.paused)}
                title={
                  item.paused
                    ? '继续倒计时'
                    : '暂停倒计时，留出打字/思考时间；暂停期间不会自动回退（钩子最多多等约 10 分钟）'
                }
              >
                {item.paused ? '继续' : '暂停'}
              </button>
              <button
                type="button"
                className="popup-pause popup-snooze-quick"
                disabled={remaining <= 300}
                onClick={() => snoozeGroup(5)}
                title={
                  remaining <= 300
                    ? '剩余时间不足 5 分钟，稍后提醒会直接超时'
                    : '5 分钟后再提醒，倒计时继续'
                }
              >
                稍后 5m
              </button>
            </div>

            {questionMode ? (
              <div className="popup-actions stack">
                {answerErrors.length > 0 ? (
                  <div className="question-hint" role="alert">
                    {answerErrors.length === 1
                      ? '还有 1 道题未回答，请先处理标出的问题。'
                      : `还有 ${answerErrors.length} 道题未回答，请先处理标出的问题。`}
                  </div>
                ) : null}
                <button
                  className="popup-btn allow"
                  disabled={busy}
                  onClick={submitAnswers}
                >
                  确认回答
                </button>
                <button className="popup-terminal" disabled={busy} onClick={ask}>
                  交给终端
                </button>
              </div>
            ) : (
              <div className={`popup-actions ${item.options.length <= 2 ? 'inline' : 'stack'}`}>
                {highRisk ? (
                  <div className={`confirm-bar ${confirmHighRisk ? 'active' : ''}`}>
                    {confirmHighRisk
                      ? '高风险操作，再按一次 Enter 或点击“仍然允许”确认'
                      : '此操作风险较高，需要二次确认'}
                  </div>
                ) : null}
                {item.options.map((option, index) => (
                  <button
                    key={option.id}
                    disabled={busy}
                    className={`popup-btn ${
                      option.id === 'allow' ? 'allow' : option.id === 'deny' ? 'deny' : 'neutral'
                    } ${option.id === 'allow' && confirmHighRisk ? 'confirm' : ''}`}
                    onClick={() =>
                      option.id === 'allow'
                        ? allow()
                        : option.id === 'deny'
                          ? setDenyOpen(true)
                          : respondGroup(option.id)
                    }
                  >
                    <kbd className="option-key">{index + 1}</kbd>
                    {option.id === 'allow' && confirmHighRisk
                      ? '仍然允许'
                      : option.id === 'allow' && item.tool === 'ExitPlanMode'
                        ? '批准计划并退出计划模式'
                        : option.label}
                  </button>
                ))}
                <button className="popup-terminal" disabled={busy} onClick={ask}>
                  交给终端
                </button>
                {denyOpen ? (
                  <div className="deny-box">
                    <label htmlFor="deny-reason">拒绝理由（可选，会回传给 Claude）</label>
                    <textarea
                      id="deny-reason"
                      className="deny-reason"
                      value={denyReason}
                      maxLength={2000}
                      autoFocus
                      placeholder="例如：不要修改这个文件，先说明你的方案"
                      onChange={(event) => setDenyReason(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault()
                          submitDeny(true)
                        }
                      }}
                    />
                    <div className="deny-chips">
                      {['先说明方案再改', '不要修改这个文件', '换个更安全的方式'].map(
                        (text) => (
                          <button
                            key={text}
                            className="chip"
                            onClick={() => setDenyReason(text)}
                          >
                            {text}
                          </button>
                        )
                      )}
                    </div>
                    <div className="deny-actions">
                      <button className="popup-btn deny" onClick={() => submitDeny(true)}>
                        拒绝并说明
                      </button>
                      <button className="popup-terminal" onClick={() => submitDeny(false)}>
                        直接拒绝
                      </button>
                      <button className="link" onClick={() => setDenyOpen(false)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            <div className="popup-consequence">
              {questionMode
                ? '提交后答案会回传给 Claude；交给终端则继续在终端回答。'
                : `${lastForSession ? '这是该会话最后一条，允许后它会继续。' : '本次决策只影响当前这组请求。'} 回退或超时会在终端重新询问，不等于自动通过。`}
            </div>
            </div>
        ) : null}

        {isExpired ? (
          <div className="popup-foot">Enter / Esc 关闭提示</div>
        ) : (
          <div className="popup-foot">
            {muted ? '该会话已静音提醒 · ' : ''}
            {item.paused
              ? '倒计时已暂停 · 点“继续”恢复自动回退（最长约 10 分钟）'
              : '超时自动回退终端 · 回退后任务会停在终端等待'}
            {snoozedCount > 0 ? ` · 另有 ${snoozedCount} 条稍后` : ''}
          </div>
        )}
      </section>
    </div>
  )
}
