import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppState,
  ApprovalItem,
  CompletionNotice as CompletionNoticeInfo
} from '../../shared/types'
import {
  approvalCommand,
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
  sortByDeadline
} from '../../shared/session'
import {
  describeSuggestion,
  isKnownSuggestionType,
  suggestionNeedsConfirmation
} from '../../shared/suggestions'
import { clusterApprovals, clusterFor } from '../../shared/approvals'
import {
  buildAnswers,
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

export default function Popup(): React.JSX.Element | null {
  const [state, setState] = useState<AppState | null>(null)
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
  const cardRef = useRef<HTMLElement>(null)

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
        ? sortByDeadline(
            state.pending.filter(
              (entry) => !entry.snoozedUntil || entry.snoozedUntil <= now
            )
          )
        : [],
    [state, now]
  )
  const selected = useMemo(() => {
    if (!state) return null
    if (selectedId) {
      const found = pending.find((item) => item.id === selectedId)
      if (found) return found
    }
    return pending[0] || null
  }, [pending, selectedId, state])
  const expired = selected ? null : state?.expired[0] || null
  const item = selected || expired
  const isExpired = Boolean(expired && !selected)
  const allClusters = useMemo(
    () => (state ? clusterApprovals(state.pending) : []),
    [state?.pending]
  )
  const actionItems = useMemo(
    () => (item && !isExpired ? clusterFor(allClusters, item.id) : []),
    [allClusters, item?.id, isExpired]
  )
  const colorFor = (key: string): string =>
    state?.sessions.find((session) => session.key === key)?.color || sessionColor(key)
  const titleFor = (key: string, fallback: string): string =>
    state?.sessions.find((session) => session.key === key)?.title || fallback

  useEffect(() => {
    if (!item) return
    setDetailsOpen(false)
    setConfirmHighRisk(false)
    setDenyOpen(false)
    setDenyReason('')
    setSuggestionConfirm(null)
    setAnswerErrors([])
    setActiveQuestion(0)
    setRenaming(false)
    setNameDraft('')
    setDrafts((current) => {
      if (current[item.id]) return current
      return { ...current, [item.id]: emptyDrafts(item) }
    })
  }, [item?.id])

  const popupPadding = state?.app.platform === 'win32' ? 8 : 18

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const observer = new ResizeObserver(() => {
      api.resizePopup(Math.ceil(card.scrollHeight + popupPadding * 2))
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [item?.id, detailsOpen, showQueue, popupPadding])

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

  const waitingSessions = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string
        title: string
        task: string
        color: string
        count: number
        pausedCount: number
        earliest: number
      }
    >()
    for (const entry of pending) {
      const session = state?.sessions.find((candidate) => candidate.key === entry.sessionKey)
      const existing = groups.get(entry.sessionKey)
      if (existing) {
        existing.count += 1
        if (entry.paused) existing.pausedCount += 1
        else existing.earliest = Math.min(existing.earliest, entry.timeoutAt)
      } else {
        groups.set(entry.sessionKey, {
          key: entry.sessionKey,
          title: session?.title || entry.sessionLabel,
          task: session?.task || entry.task || '',
          color: session?.color || sessionColor(entry.sessionKey),
          count: 1,
          pausedCount: entry.paused ? 1 : 0,
          earliest: entry.paused ? Number.POSITIVE_INFINITY : entry.timeoutAt
        })
      }
    }
    return [...groups.values()]
      .map((group) => ({ ...group, paused: group.pausedCount === group.count }))
      .sort((left, right) => {
        if (left.paused !== right.paused) return left.paused ? 1 : -1
        return left.earliest - right.earliest
      })
  }, [pending, state?.sessions])

  const submitAnswers = (): void => {
    if (!item) return
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
    void api.respond(item.id, 'answer', {
      answers: buildAnswers(item.questions, draft)
    })
  }

  const respondGroup = (decision: string, extra?: { reason?: string }): void => {
    if (!item) return
    const ids = actionItems.length > 0 ? actionItems.map((entry) => entry.id) : [item.id]
    if (ids.length === 1) void api.respond(ids[0], decision, extra)
    else void api.respondMany(ids, decision, extra)
  }

  const allow = (): void => {
    if (!item) return
    const allowOption = item.options.find((option) => option.id === 'allow')
    if (!allowOption) return
    if (highRisk && state?.prefs.enterConfirmsHighRisk && !confirmHighRisk) {
      setConfirmHighRisk(true)
      return
    }
    respondGroup(allowOption.id)
  }

  const ask = (): void => {
    if (!item) return
    respondGroup('ask')
  }

  const submitDeny = (withReason: boolean): void => {
    if (!item) return
    const reason = withReason ? denyReason.trim().slice(0, 2000) : ''
    respondGroup('deny', reason ? { reason } : undefined)
  }

  const snoozeGroup = (minutes: number): void => {
    if (!item) return
    const ids = actionItems.length > 0 ? actionItems.map((entry) => entry.id) : [item.id]
    for (const id of ids) void api.snoozeApproval(id, minutes)
  }

  const togglePause = (): void => {
    if (!item || isExpired) return
    setSelectedId(item.id)
    void api.pauseApproval(item.id, !item.paused)
  }

  const acknowledge = (id?: string): void => {
    void api.acknowledgeExpired(id)
  }

  const submitExpired = (): void => {
    acknowledge()
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
      scope: 'project',
      tool: item.tool,
      pattern: command,
      project: item.project,
      origin: item.origin,
      ...(expiresAt ? { expiresAt } : {})
    })
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
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(
        target?.tagName === 'INPUT' ||
          target?.tagName === 'TEXTAREA' ||
          target?.isContentEditable
      )
      if (isExpired) {
        if (event.key === 'Escape' || event.key === 'Enter') {
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
      const switchModifier = state?.app.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (switchModifier && /^[1-9]$/.test(event.key)) {
        const target = waitingSessions[Number(event.key) - 1]
        const first = target
          ? pending.find((entry) => entry.sessionKey === target.key)
          : undefined
        if (first) {
          event.preventDefault()
          setSelectedId(first.id)
          setShowQueue(false)
        }
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
          if (next) setSelectedId(next.id)
        }
        return
      }
      if (event.key === 'Escape') {
        if (typing) {
          // 输入框内的 Esc 先退出输入，不提交“交给终端”；再按一次才交给终端。
          event.preventDefault()
          target?.blur()
          return
        }
        event.preventDefault()
        ask()
        return
      }
      if (typing) return
      if (target?.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) {
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
  }, [item, isExpired, highRisk, confirmHighRisk, draft, state, activeQuestion])

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
    .filter((entry) => !entry.paused && remainingSeconds(entry.timeoutAt, now) <= 15)
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
  const sameSessionItems = pending.filter((entry) => entry.sessionKey === item.sessionKey)
  const sessionPosition = waitingSessions.findIndex(
    (session) => session.key === item.sessionKey
  )
  const requestPosition = sameSessionItems.findIndex((entry) => entry.id === item.id)
  const switchModifierLabel = state.app.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const queueGroups = groupBySession(pending).map((group) => {
    const session = state.sessions.find((candidate) => candidate.key === group.key)
    const first = group.items[0]
    return {
      key: group.key,
      items: group.items,
      title: session?.title || first.sessionLabel,
      task: session?.task || first.task || '',
      color: session?.color || sessionColor(group.key)
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
          onClick={() => (isExpired ? acknowledge() : ask())}
          aria-label={isExpired ? '关闭回退提示' : '关闭并交给终端'}
          title={isExpired ? '关闭提示' : '关闭（交给终端）'}
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
        </header>

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
                <div className="identity-task" title={identity.task}>
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
                : '超时未处理将自动返回终端，不会卡住 Claude Code。'}
        </p>

        {isExpired ? (
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
              <div className="expired-more">还有 {state.expired.length - 6} 条…</div>
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
                <button className="link" onClick={() => acknowledge()}>
                  知道了
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
            </div>
            {duplicateCount > 1 ? (
              <div className="popup-duplicate-note">
                这些请求的工具和参数完全一致；本次允许/拒绝/交给终端会同时处理 {duplicateCount} 条。
              </div>
            ) : null}

            {waitingSessions.length > 1 ? (
              <div className="session-strip" role="tablist" aria-label="等待中的会话">
                {waitingSessions.map((session) => {
                  const active = session.key === item.sessionKey
                  const left = Number.isFinite(session.earliest)
                    ? Math.max(0, Math.ceil((session.earliest - now) / 1000))
                    : 0
                  return (
                    <button
                      key={session.key}
                      role="tab"
                      aria-selected={active}
                      className={`session-chip ${active ? 'active' : ''}`}
                      style={{ '--session-color': session.color } as React.CSSProperties}
                      title={`${session.title}${session.task ? ` · ${session.task}` : ''}`}
                      onClick={() => {
                        const first = pending.find((entry) => entry.sessionKey === session.key)
                        if (first) setSelectedId(first.id)
                      }}
                    >
                      <i aria-hidden="true" />
                      <span className="session-chip-name">{session.title}</span>
                      <span className="session-chip-task">
                        {session.task || '暂无任务摘要'}
                      </span>
                      {session.count > 1 ? <b>{session.count}</b> : null}
                      <em className={session.paused ? 'paused' : ''}>
                        {session.paused ? '已暂停' : `${left}s`}
                      </em>
                    </button>
                  )
                })}
              </div>
            ) : null}

            {urgentQueued ? (
              <div className="urgent-queue">
                <span>
                  “{titleFor(urgentQueued.sessionKey, urgentQueued.sessionLabel)}”的审批将在{' '}
                  {remainingSeconds(urgentQueued.timeoutAt, now)}s 后回退终端
                </span>
                <button className="link" onClick={() => setSelectedId(urgentQueued.id)}>
                  切换处理
                </button>
              </div>
            ) : null}

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

            {questionMode ? (
              <div className="question-list">
                {item.questions.map((question, index) => {
                  const entry = draft[index] || { selected: [], text: '', other: false }
                  const multi = Boolean(question.multiSelect)
                  const invalid = answerErrors.includes(index)
                  return (
                    <div
                      className="question-block"
                      key={`${question.question}-${index}`}
                      data-question-index={index}
                      tabIndex={-1}
                      onClick={() => setActiveQuestion(index)}
                      onFocus={() => setActiveQuestion(index)}
                    >
                      <div className="question-head">
                        {item.questions.length > 1 ? (
                          <span className="question-index">问题 {index + 1}</span>
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
                          placeholder="输入自己的回答，Enter 提交"
                          onChange={(event) => updateText(index, event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              submitAnswers()
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
                    {diffs.map((diff, index) => (
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
                        {diff.oldText ? (
                          <pre className="diff-old">
                            {diff.oldText
                              .split('\n')
                              .map((line: string) => `- ${line}`)
                              .join('\n')}
                          </pre>
                        ) : null}
                        {diff.newText ? (
                          <pre className="diff-new">
                            {diff.newText
                              .split('\n')
                              .map((line: string) => `+ ${line}`)
                              .join('\n')}
                          </pre>
                        ) : null}
                      </div>
                    ))}
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
                className={`${remaining <= 15 && !item.paused ? 'urgent' : ''} ${
                  item.paused ? 'paused' : ''
                }`}
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
            </div>

            {!isExpired ? (
              <div className="popup-snooze">
                <span>稍后提醒</span>
                {[1, 5, 15].map((minutes) => (
                  <button
                    key={minutes}
                    className="link"
                    onClick={() => snoozeGroup(minutes)}
                    title={`${minutes} 分钟后重新弹出，倒计时继续`}
                  >
                    {minutes} 分钟
                  </button>
                ))}
              </div>
            ) : null}

            {questionMode ? (
              <div className="popup-actions stack">
                {answerErrors.length > 0 ? (
                  <div className="question-hint" role="alert">
                    {answerErrors.length === 1
                      ? '还有 1 道题未回答，请先处理标出的问题。'
                      : `还有 ${answerErrors.length} 道题未回答，请先处理标出的问题。`}
                  </div>
                ) : null}
                <button className="popup-btn allow" onClick={submitAnswers}>
                  确认回答
                </button>
                <button className="popup-terminal" onClick={ask}>
                  交给终端
                </button>
              </div>
            ) : (
              <div className={`popup-actions ${item.options.length <= 2 && !highRisk ? 'inline' : 'stack'}`}>
                {highRisk ? (
                  <div className={`confirm-bar ${confirmHighRisk ? 'active' : ''}`}>
                    {confirmHighRisk
                      ? '高风险操作，再按一次 Enter 或点击“仍然允许”确认'
                      : '此操作风险较高，需要二次确认'}
                  </div>
                ) : null}
                {item.options.map((option) => (
                  <button
                    key={option.id}
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
                    {option.id === 'allow' && confirmHighRisk
                      ? '仍然允许'
                      : option.id === 'allow' && item.tool === 'ExitPlanMode'
                        ? '批准计划并退出计划模式'
                        : option.label}
                  </button>
                ))}
                <button className="popup-terminal" onClick={ask}>
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
                      disabled={!known}
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
                        void api.respond(item.id, 'suggestion', { index })
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

            {canRememberRule ? (
              <div className="popup-remember-row">
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
                <button className="popup-remember" onClick={rememberRule}>
                  以后允许此命令（{item.project} · {item.origin}）
                </button>
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
              {pending.length > 1 ? (
                <button
                  className="popup-queue-toggle"
                  onClick={() => setShowQueue((value) => !value)}
                  aria-expanded={showQueue}
                  title={`${switchModifierLabel}1–9 切换会话；${switchModifierLabel}↑/↓ 切换本会话请求`}
                >
                  {waitingSessions.length} 个会话 · {pending.length} 条待审批
                  {queue.length > 0 ? ` · 还有 ${queue.length} 条` : ''}
                </button>
              ) : null}
              <span className="popup-foot-hint">
                {waitingSessions.length > 1 ? `${switchModifierLabel}1–9 切会话 · ` : ''}
                {questionMode
                  ? '1–9 答当前题 · Enter 提交 · Esc 交给终端'
                  : highRisk
                    ? 'Enter 二次确认 · Esc 交给终端'
                    : 'Enter 允许 · Esc 交给终端'}
              </span>
            </div>

            {showQueue ? (
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
                      <em>{group.items.length} 条</em>
                    </div>
                    {group.items.map((entry) => {
                      const paused = Boolean(entry.paused)
                      const left = paused ? 0 : remainingSeconds(entry.timeoutAt, now)
                      const active = entry.id === item.id
                      const command = approvalCommand(entry) || entry.message
                      return (
                        <button
                          key={entry.id}
                          role="listitem"
                          className={`queue-row ${active ? 'active' : ''} ${
                            left <= 15 && !paused ? 'urgent' : ''
                          }`}
                          onClick={() => {
                            setSelectedId(entry.id)
                            setShowQueue(false)
                          }}
                        >
                          <span className="queue-tool">{entry.tool}</span>
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
              </div>
            ) : null}
          </>
        )}

        {isExpired ? (
          <div className="popup-foot">Enter / Esc 关闭提示</div>
        ) : (
          <div className="popup-foot">
            {muted ? '该会话已静音提醒 · ' : ''}
            {item.paused
              ? '倒计时已暂停 · 点“继续”恢复自动回退（最长约 10 分钟）'
              : '超时自动回退终端'}
          </div>
        )}
      </section>
    </div>
  )
}
