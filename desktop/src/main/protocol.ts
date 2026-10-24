import { describeSuggestion, unknownSuggestionTypes } from '../shared/suggestions'
import {
  assessRisk,
  deriveSessionLabel,
  projectName,
  sessionKeyOf
} from '../shared/session'
import type {
  ApprovalItem,
  ApprovalKind,
  ApprovalOption,
  ApprovalQuestion,
  ApprovalSuggestion,
  QuestionOption
} from '../shared/types'

const MAX_OPTIONS = 6
const MAX_SUGGESTIONS = 6
const MAX_QUESTIONS = 4
const MAX_QUESTION_OPTIONS = 8
const MAX_DETAIL = 6000

export function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export { projectName } from '../shared/session'

export function normalizeOptions(raw: unknown): ApprovalOption[] {
  const options: ApprovalOption[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const option = asRecord(item)
      const id = safeString(option.id)
      const label = safeString(option.label)
      if (id && label) options.push({ id, label })
    }
  }
  if (options.length === 0) {
    options.push({ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' })
  }
  return options.slice(0, MAX_OPTIONS)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function normalizeSuggestions(raw: unknown): ApprovalSuggestion[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const suggestions: ApprovalSuggestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const suggestion = item as ApprovalSuggestion
    const key = stableStringify(suggestion)
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push(suggestion)
  }
  return suggestions.slice(0, MAX_SUGGESTIONS)
}

export function normalizeQuestions(raw: unknown, fallbackMessage: string): ApprovalQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: ApprovalQuestion[] = []
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    const question = asRecord(item)
    const options: QuestionOption[] = []
    if (Array.isArray(question.options)) {
      for (const rawOption of question.options.slice(0, MAX_QUESTION_OPTIONS)) {
        const option = asRecord(rawOption)
        const label = safeString(option.label)
        if (!label) continue
        const description = safeString(option.description)
        options.push(description ? { label, description } : { label })
      }
    }
    const text = safeString(question.question) || fallbackMessage
    questions.push({
      question: text,
      header: safeString(question.header) || undefined,
      multiSelect: Boolean(question.multiSelect),
      options
    })
  }
  return questions
}

export function normalizeKind(raw: unknown): ApprovalKind {
  return raw === 'question' ? 'question' : 'permission'
}

export function approvalFromPayload(
  payload: Record<string, unknown>,
  id: string,
  now: number,
  timeoutSec: number
): ApprovalItem {
  const tool = safeString(payload.tool_name) || '未知工具'
  const cwd = safeString(payload.cwd)
  const project = projectName(cwd)
  const sessionId = safeString(payload.session_id)
  const origin = safeString(payload.origin) || '本机'
  const tty = safeString(payload.tty)
  const terminal = safeString(payload.terminal)
  const promptId = safeString(payload.prompt_id)
  const toolUseId = safeString(payload.tool_use_id)
  const toolInput = asRecord(payload.tool_input)
  const message =
    safeString(payload.message) || `工具 ${tool} 请求权限审批`
  const detail = JSON.stringify(toolInput, null, 2).slice(0, MAX_DETAIL)
  const sessionKey = sessionKeyOf({ origin, sessionId, cwd, tty })
  const sessionLabel =
    safeString(payload.session_label) ||
    deriveSessionLabel({ project, terminal, tty, sessionId })
  const task = safeString(payload.task).trim().slice(0, 160)
  const branch = safeString(payload.branch).trim().slice(0, 80)
  const correlationField = safeString(payload.correlation)
  const correlation: ApprovalItem['correlation'] =
    correlationField === 'unmatched'
      ? 'unmatched'
      : correlationField === 'exact' || toolUseId
        ? 'exact'
        : 'unknown'

  return {
    id,
    requestId: safeString(payload.request_id) || toolUseId || id,
    sessionId,
    sessionKey,
    sessionLabel,
    origin,
    promptId,
    toolUseId,
    transcriptPath: safeString(payload.transcript_path),
    kind: normalizeKind(payload.kind),
    tool,
    project,
    cwd,
    tty,
    terminal,
    task,
    branch,
    message,
    detail,
    toolInput,
    options: normalizeOptions(payload.options),
    suggestions: normalizeSuggestions(payload.suggestions),
    questions: normalizeQuestions(payload.questions, message),
    risk: assessRisk(tool, toolInput),
    correlation,
    createdAt: now,
    timeoutAt: now + timeoutSec * 1000,
    timeoutSec
  }
}

export function buildNotification(
  payload: Record<string, unknown>
): { title: string; body: string } {
  const cwd = safeString(payload.cwd)
  const sessionId = safeString(payload.session_id)
  const origin = safeString(payload.origin) || '本机'
  const project = projectName(cwd)
  const message = safeString(payload.message)
  const task = safeString(payload.task).trim()
  const branch = safeString(payload.branch).trim()
  const notificationType = safeString(payload.notification_type)
  const matcher = safeString(payload.matcher)
  const event = notificationType || matcher
  const isStop = event === 'Stop' || matcher === 'Stop'
  const isIdle =
    /idle|waiting_for_input|waiting.?for.?input/i.test(event) ||
    matcher === 'idle_prompt'
  const isQuestion = /elicitation|question/i.test(event)
  const title = isStop
    ? `Claude Code 已完成 · ${project}`
    : isIdle
      ? `Claude Code 等待输入 · ${project}`
      : isQuestion
        ? `Claude Code 需要回答 · ${project}`
        : event === 'auth_success'
          ? `Claude Code 认证成功 · ${project}`
          : `Claude Code 等待审批 · ${project}`
  const fallbackBody = isStop
    ? 'Claude Code 已完成当前回合。'
    : isIdle
      ? 'Claude Code 正在等待你的输入。'
      : isQuestion
        ? 'Claude Code 需要你回答一个问题。'
        : 'Claude Code 正在等待权限审批。'
  const bodyParts = [message || fallbackBody]
  if (task) bodyParts.push(`任务：${task}`)
  bodyParts.push(`来源：${origin}${branch ? ` · ${branch}` : ''}${cwd ? ` · ${cwd}` : ''}`)
  if (notificationType) bodyParts.push(`类型：${notificationType}`)
  if (sessionId) bodyParts.push(`会话：${sessionId.slice(0, 8)}`)
  return { title, body: bodyParts.join('\n') }
}

export { describeSuggestion, unknownSuggestionTypes } from '../shared/suggestions'
