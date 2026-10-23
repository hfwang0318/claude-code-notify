import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ApprovalItem } from '../../shared/types'
import {
  approvalCommand,
  extractEditDiff,
  prettyToolInput,
  remainingSeconds,
  riskLabel,
  riskSegments,
  sessionColor,
  sortByDeadline
} from '../../shared/session'
import { describeSuggestion } from '../../shared/suggestions'
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

function sourceLabel(item: ApprovalItem): string {
  const candidates = [item.terminal, item.tty, item.origin]
  return candidates.find((value) => value && !item.sessionLabel.includes(value)) || ''
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
  const [copied, setCopied] = useState(false)
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
    () => (state ? sortByDeadline(state.pending) : []),
    [state]
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
  const colorFor = (key: string): string =>
    state?.sessions.find((session) => session.key === key)?.color || sessionColor(key)

  useEffect(() => {
    if (!item) return
    setDetailsOpen(false)
    setConfirmHighRisk(false)
    setAnswerErrors([])
    setActiveQuestion(0)
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

  const remaining = item && !isExpired ? remainingSeconds(item.timeoutAt, now) : 0
  const total = Math.max(1, item?.timeoutSec || 1)
  const progress = Math.max(0, Math.min(1, remaining / total))
  const draft = item ? drafts[item.id] || emptyDrafts(item) : []
  const questionMode = item?.kind === 'question' && !isExpired
  const highRisk = item?.risk.level === 'high'
  const command = item ? approvalCommand(item) : ''
  const diff = item && !questionMode ? extractEditDiff(item.toolInput) : null
  const canRememberRule =
    item &&
    !questionMode &&
    !highRisk &&
    item.risk.level === 'medium' &&
    Boolean(command) &&
    item.tool !== 'AskUserQuestion'

  const waitingSessions = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; label: string; color: string; count: number; earliest: number }
    >()
    for (const entry of pending) {
      const existing = groups.get(entry.sessionKey)
      if (existing) {
        existing.count += 1
        existing.earliest = Math.min(existing.earliest, entry.timeoutAt)
      } else {
        groups.set(entry.sessionKey, {
          key: entry.sessionKey,
          label: entry.sessionLabel,
          color:
            state?.sessions.find((session) => session.key === entry.sessionKey)?.color ||
            sessionColor(entry.sessionKey),
          count: 1,
          earliest: entry.timeoutAt
        })
      }
    }
    return [...groups.values()].sort((left, right) => left.earliest - right.earliest)
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

  const allow = (): void => {
    if (!item) return
    const allowOption = item.options.find((option) => option.id === 'allow')
    if (!allowOption) return
    if (highRisk && state?.prefs.enterConfirmsHighRisk && !confirmHighRisk) {
      setConfirmHighRisk(true)
      return
    }
    void api.respond(item.id, allowOption.id)
  }

  const ask = (): void => {
    if (!item) return
    void api.respond(item.id, 'ask')
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
    void api.addRule({
      scope: 'project',
      tool: item.tool,
      pattern: command,
      project: item.project
    })
  }

  const copyDetail = (): void => {
    if (!item) return
    void api.copy(detailsOpen ? prettyToolInput(item.toolInput) : command)
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
        else void api.respond(item.id, option.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [item, isExpired, highRisk, confirmHighRisk, draft, state, activeQuestion])

  if (!state || !item) return null

  const queue = pending.filter((entry) => entry.id !== item.id)
  const urgentQueued = queue
    .filter((entry) => remainingSeconds(entry.timeoutAt, now) <= 15)
    .sort((left, right) => left.timeoutAt - right.timeoutAt)[0]
  const selectedSession = state.sessions.find((session) => session.key === item.sessionKey)
  const muted = (selectedSession?.mutedUntil || 0) > now

  return (
    <div className="popup-stage" data-platform={state.app.platform}>
      <section
        ref={cardRef}
        className={`popup-card risk-${item.risk.level}`}
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
          {item.origin !== '本机' && !item.sessionLabel.includes(item.origin) ? (
            <span className="popup-origin">{item.origin}</span>
          ) : null}
          <span className="popup-time">{formatTime(item.createdAt)}</span>
        </header>

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
                  <b>{entry.sessionLabel}</b>
                  <span>
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

            <div className="popup-session-row">
              <span
                className="session-dot"
                style={{ background: colorFor(item.sessionKey) }}
                aria-hidden="true"
              />
              <span className="popup-session-label" title={item.cwd}>
                {item.sessionLabel}
              </span>
              {sourceLabel(item) ? (
                <span className="popup-source">{sourceLabel(item)}</span>
              ) : null}
              {muted ? <span className="popup-muted">静音提醒</span> : null}
              <span className="popup-chip">工具 · {item.tool}</span>
              {item.risk.level !== 'low' ? (
                <span className={`risk-chip risk-${item.risk.level}`}>
                  {riskLabel(item.risk.level)}
                </span>
              ) : null}
            </div>

            {waitingSessions.length > 1 ? (
              <div className="session-strip" role="tablist" aria-label="等待中的会话">
                {waitingSessions.map((session) => {
                  const active = session.key === item.sessionKey
                  const left = Math.max(0, Math.ceil((session.earliest - now) / 1000))
                  return (
                    <button
                      key={session.key}
                      role="tab"
                      aria-selected={active}
                      className={`session-chip ${active ? 'active' : ''}`}
                      style={{ '--session-color': session.color } as React.CSSProperties}
                      onClick={() => {
                        const first = pending.find((entry) => entry.sessionKey === session.key)
                        if (first) setSelectedId(first.id)
                      }}
                    >
                      <i aria-hidden="true" />
                      <span>{session.label}</span>
                      {session.count > 1 ? <b>{session.count}</b> : null}
                      <em>{left}s</em>
                    </button>
                  )
                })}
              </div>
            ) : null}

            {urgentQueued ? (
              <div className="urgent-queue">
                <span>
                  “{urgentQueued.sessionLabel}”的审批将在{' '}
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
                {diff ? (
                  <div className="popup-diff">
                    <div className="popup-diff-head">
                      <span className="popup-diff-path">{diff.filePath}</span>
                      <button className="link" onClick={copyDetail}>
                        {copied ? '已复制' : '复制diff'}
                      </button>
                    </div>
                    {diff.oldText ? (
                      <pre className="diff-old">
                        {diff.oldText.split('\n').map((line) => `- ${line}`).join('\n')}
                      </pre>
                    ) : null}
                    {diff.newText ? (
                      <pre className="diff-new">
                        {diff.newText.split('\n').map((line) => `+ ${line}`).join('\n')}
                      </pre>
                    ) : null}
                  </div>
                ) : (
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

            <div className="popup-count">
              <div
                className="popup-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <b className={remaining <= 15 ? 'urgent' : ''}>{remaining}s</b>
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
                        : void api.respond(item.id, option.id)
                    }
                  >
                    {option.id === 'allow' && confirmHighRisk ? '仍然允许' : option.label}
                  </button>
                ))}
                <button className="popup-terminal" onClick={ask}>
                  交给终端
                </button>
              </div>
            )}

            {item.suggestions.length > 0 ? (
              <div className="popup-suggestions">
                <div className="popup-suggestions-title">权限建议</div>
                {item.suggestions.map((suggestion, index) => (
                  <button
                    key={`${describeSuggestion(suggestion)}-${index}`}
                    className="popup-btn suggestion"
                    title={JSON.stringify(suggestion, null, 2)}
                    onClick={() => void api.respond(item.id, 'suggestion', { index })}
                  >
                    {describeSuggestion(suggestion)}
                  </button>
                ))}
              </div>
            ) : null}

            {canRememberRule ? (
              <button className="popup-remember" onClick={rememberRule}>
                以后允许此命令（项目 {item.project}）
              </button>
            ) : null}

            <div className="popup-queue-row">
              <button
                className="popup-queue-toggle"
                onClick={() => setShowQueue((value) => !value)}
                aria-expanded={showQueue}
              >
                {waitingSessions.length} 个会话 · {pending.length} 条待审批
                {queue.length > 0 ? ` · 还有 ${queue.length} 条` : ''}
              </button>
              <span className="popup-foot-hint">
                {questionMode
                  ? '1–9 答当前题 · Enter 提交 · Esc 交给终端'
                  : highRisk
                    ? 'Enter 二次确认 · Esc 交给终端'
                    : 'Enter 允许 · Esc 交给终端'}
              </span>
            </div>

            {showQueue ? (
              <div className="queue-list" role="list">
                {pending.map((entry) => {
                  const left = remainingSeconds(entry.timeoutAt, now)
                  const active = entry.id === item.id
                  return (
                    <button
                      key={entry.id}
                      role="listitem"
                      className={`queue-row ${active ? 'active' : ''} ${
                        left <= 15 ? 'urgent' : ''
                      }`}
                      onClick={() => {
                        setSelectedId(entry.id)
                        setShowQueue(false)
                      }}
                    >
                      <span
                        className="session-dot"
                        style={{ background: colorFor(entry.sessionKey) }}
                        aria-hidden="true"
                      />
                      <span className="queue-session">{entry.sessionLabel}</span>
                      <span className="queue-tool">{entry.tool}</span>
                      <span className="queue-time">{left}s</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </>
        )}

        {isExpired ? (
          <div className="popup-foot">Enter / Esc 关闭提示</div>
        ) : (
          <div className="popup-foot">
            {muted ? '该会话已静音提醒 · ' : ''}
            超时自动回退终端
          </div>
        )}
      </section>
    </div>
  )
}
