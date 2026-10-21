import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ApprovalAnswer, ApprovalItem } from '../../shared/types'
import { describeSuggestion } from '../../shared/suggestions'
import { api } from './api'
import { firstLine, formatTime } from './format'

interface QuestionDraft {
  selected: string[]
  text: string
  other: boolean
}

function initialDrafts(item: ApprovalItem | null): QuestionDraft[] {
  if (!item) return []
  return item.questions.map(() => ({ selected: [], text: '', other: false }))
}

export default function Popup(): React.JSX.Element | null {
  const [state, setState] = useState<AppState | null>(null)
  const [now, setNow] = useState(Date.now())
  const [drafts, setDrafts] = useState<QuestionDraft[]>([])
  const [answerHint, setAnswerHint] = useState(false)
  const cardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let alive = true
    void api.getState().then((next) => {
      if (alive) setState(next)
    })
    const off = api.onState((next) => setState(next))
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  const expired = state && state.pending.length === 0 ? state.expired : null
  const item = state?.pending[0] ?? expired ?? null

  useEffect(() => {
    setDrafts(initialDrafts(item))
    setAnswerHint(false)
  }, [item?.id])

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const observer = new ResizeObserver(() => {
      api.resizePopup(Math.ceil(card.scrollHeight + 36))
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [item])

  useEffect(() => {
    if (!item) return
    const handler = (event: KeyboardEvent): void => {
      if (expired) {
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault()
          void api.acknowledgeExpired()
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        void api.respond(item.id, 'ask')
      }
      if (event.key === 'Enter' && item.kind === 'permission') {
        const allow = item.options.find((option) => option.id === 'allow')
        if (allow) {
          event.preventDefault()
          void api.respond(item.id, allow.id)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [item, expired])

  const remaining = useMemo(() => {
    if (!item || expired) return 0
    return Math.max(0, Math.ceil((item.timeoutAt - now) / 1000))
  }, [item, expired, now])

  if (!state || !item) return null

  const queue = expired ? 0 : state.pending.length - 1
  const total = Math.max(1, item.timeoutSec)
  const progress = Math.max(0, Math.min(1, remaining / total))
  const command = firstLine(item.detail) || item.message

  const submitAnswers = (): void => {
    const answers: ApprovalAnswer[] = []
    item.questions.forEach((question, index) => {
      const draft = drafts[index]
      if (!draft) return
      const text = draft.text.trim()
      if (draft.selected.length === 0 && !text) return
      answers.push({
        question: question.question,
        selected: draft.selected,
        text
      })
    })
    if (answers.length === 0) {
      setAnswerHint(true)
      return
    }
    void api.respond(item.id, 'answer', { answers })
  }

  const toggleOption = (index: number, label: string, multi: boolean, fast: boolean): void => {
    if (fast) {
      void api.respond(item.id, 'answer', {
        answers: [{ question: item.questions[index].question, selected: [label], text: '' }]
      })
      return
    }
    setAnswerHint(false)
    setDrafts((current) =>
      current.map((draft, draftIndex) => {
        if (draftIndex !== index) return draft
        if (multi) {
          const selected = draft.selected.includes(label)
            ? draft.selected.filter((value) => value !== label)
            : [...draft.selected, label]
          return { ...draft, selected }
        }
        return { ...draft, selected: [label] }
      })
    )
  }

  const updateText = (index: number, text: string): void => {
    setAnswerHint(false)
    setDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, text } : draft
      )
    )
  }

  const toggleOther = (index: number): void => {
    setDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, other: !draft.other } : draft
      )
    )
  }

  const fastPath = item.questions.length === 1 && !item.questions[0]?.multiSelect
  const allowOption = item.options.find((option) => option.id === 'allow')
  const otherOptions = item.options.filter((option) => option.id !== 'allow')
  const hasSuggestions = item.suggestions.length > 0

  return (
    <div className="popup-stage">
      <section
        ref={cardRef}
        className="popup-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="popup-title"
      >
        <button
          className="popup-close"
          onClick={() => void (expired ? api.acknowledgeExpired() : api.respond(item.id, 'ask'))}
          aria-label={expired ? '关闭提示' : '关闭并交给终端'}
          title={expired ? '关闭提示' : '关闭（交给终端）'}
        >
          ×
        </button>

        <header className="popup-head">
          <span className="popup-kicker">
            {expired
              ? 'RETURNED TO TERMINAL'
              : item.kind === 'question'
                ? 'Answer Required'
                : 'Permission Required'}
          </span>
          <span className="popup-time">{formatTime(item.createdAt)}</span>
        </header>

        <h1 className="popup-title" id="popup-title">
          {expired ? '审批已回退终端' : item.message || 'Claude 请求执行权限'}
        </h1>
        <p className="popup-sub">
          {expired
            ? '超时未处理，弹窗已不再提交决定；请在终端继续。'
            : item.kind === 'question'
              ? '选择答案后提交；也可以交给终端继续回答。'
              : '默认焦点在“允许”；超时未处理将自动返回终端。'}
        </p>

        <div className="popup-meta">
          <span className="popup-chip">TOOL · {item.tool}</span>
          {item.project ? <span className="popup-project">{item.project}</span> : null}
          {queue > 0 ? <span className="popup-queue">还有 {queue} 条</span> : null}
        </div>

        {item.kind === 'question' && !expired ? (
          <div className="question-list">
            {item.questions.map((question, index) => {
              const draft = drafts[index] || { selected: [], text: '', other: false }
              const multi = Boolean(question.multiSelect)
              return (
                <div className="question-block" key={`${question.question}-${index}`}>
                  {item.questions.length > 1 ? (
                    <div className="question-index">问题 {index + 1}</div>
                  ) : null}
                  <div className="question-text">{question.question}</div>
                  {question.options.length > 0 ? (
                    <div className="question-options">
                      {question.options.map((option) => {
                        const selected = draft.selected.includes(option.label)
                        return (
                          <button
                            key={option.label}
                            className={`question-option ${selected ? 'selected' : ''} ${
                              multi ? 'multi' : ''
                            }`}
                            onClick={() =>
                              toggleOption(index, option.label, multi, fastPath)
                            }
                          >
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
                  >
                    {draft.other ? '收起自定义回答' : '其他（自己输入）…'}
                  </button>
                  {draft.other ? (
                    <input
                      className="question-input"
                      value={draft.text}
                      autoFocus
                      placeholder="输入你自己的回答，Enter 提交"
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
          <div className="popup-command" title={command}>
            {command}
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
          <b>{expired ? '已回退' : `${remaining}s`}</b>
        </div>

        {expired ? (
          <div className="popup-actions stack">
            <button className="popup-btn allow" onClick={() => void api.acknowledgeExpired()}>
              我知道了
            </button>
          </div>
        ) : item.kind === 'question' ? (
          <div className="popup-actions stack">
            {answerHint ? (
              <div className="question-hint">请选择一个选项或输入回答</div>
            ) : null}
            {!fastPath ? (
              <button className="popup-btn allow" onClick={submitAnswers}>
                确认回答
              </button>
            ) : null}
            <button className="popup-terminal" onClick={() => void api.respond(item.id, 'ask')}>
              交给终端
            </button>
          </div>
        ) : hasSuggestions ? (
          <div className="popup-actions stack">
            {allowOption ? (
              <button
                className="popup-btn allow"
                onClick={() => void api.respond(item.id, 'allow')}
              >
                {allowOption.label}
              </button>
            ) : null}
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
            {otherOptions.map((option) => (
              <button
                key={option.id}
                className={`popup-btn ${
                  option.id === 'deny' ? 'deny' : 'neutral'
                }`}
                onClick={() => void api.respond(item.id, option.id)}
              >
                {option.label}
              </button>
            ))}
            <button className="popup-terminal" onClick={() => void api.respond(item.id, 'ask')}>
              交给终端
            </button>
          </div>
        ) : (
          <div className={`popup-actions ${item.options.length <= 2 ? 'inline' : 'stack'}`}>
            {item.options.map((option) => (
              <button
                key={option.id}
                className={`popup-btn ${
                  option.id === 'allow' ? 'allow' : option.id === 'deny' ? 'deny' : 'neutral'
                }`}
                onClick={() => void api.respond(item.id, option.id)}
              >
                {option.label}
              </button>
            ))}
            <button className="popup-terminal" onClick={() => void api.respond(item.id, 'ask')}>
              交给终端
            </button>
          </div>
        )}

        <div className="popup-foot">
          {expired
            ? 'Enter / Esc 关闭提示'
            : item.kind === 'question'
              ? 'Enter 提交 · Esc 交给终端 · 超时自动回退'
              : 'Enter 允许 · Esc 交给终端 · 超时自动回退'}
        </div>
      </section>
    </div>
  )
}
