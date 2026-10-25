import type { ApprovalRecord } from './types'

/**
 * Human-facing wording for one tool. These strings are rendered in the popup
 * headline and the primary button, so they must describe the *decision* rather
 * than repeat the raw tool name.
 */
export interface ToolWording {
  /** Content heading, e.g. "要执行". */
  content: string
  /** Primary allow button, e.g. "允许执行". */
  allow: string
}

const TOOL_WORDING: Record<string, ToolWording> = {
  bash: { content: '要执行', allow: '允许执行' },
  shell: { content: '要执行', allow: '允许执行' },
  edit: { content: '要修改文件', allow: '允许修改' },
  multiedit: { content: '要修改文件', allow: '允许修改' },
  notebookedit: { content: '要修改 Notebook', allow: '允许修改' },
  write: { content: '要写入文件', allow: '允许写入' },
  read: { content: '要读取文件', allow: '允许读取' },
  webfetch: { content: '要访问网页', allow: '允许访问' },
  websearch: { content: '要搜索网页', allow: '允许搜索' },
  exitplanmode: { content: '计划', allow: '批准计划' },
  askuserquestion: { content: '需要回答', allow: '确认回答' },
  task: { content: '要启动子任务', allow: '允许启动' },
  skill: { content: '要运行技能', allow: '允许运行' },
  glob: { content: '要查找文件', allow: '允许查找' },
  grep: { content: '要搜索内容', allow: '允许搜索' }
}

export function toolWording(tool: string): ToolWording {
  const key = (tool || '').trim().toLowerCase()
  if (TOOL_WORDING[key]) return TOOL_WORDING[key]
  if (key.startsWith('mcp__')) {
    return { content: '要调用外部工具', allow: '允许调用' }
  }
  return { content: '要执行操作', allow: '允许' }
}

const SUMMARY_KEYS = [
  'description',
  'prompt',
  'query',
  'pattern',
  'url',
  'file_path',
  'path',
  'command',
  'skill',
  'subagent_type',
  'name'
] as const

/** Inputs that are already rendered as a dedicated diff/plan block. */
const HIDDEN_SUMMARY_KEYS = new Set([
  'old_string',
  'new_string',
  'old_str',
  'new_str',
  'content',
  'edits',
  'questions',
  'timeout_seconds'
])

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

/**
 * Best-effort human summary for tool inputs that have no command, diff or plan
 * (MCP tools, Task, Skill, ...). The popup used to fall back to the hook's
 * generic "Claude Code 想要使用工具 X" message here, which told the user nothing.
 */
export function toolInputSummary(input: Record<string, unknown>, max = 180): string[] {
  const lines: string[] = []
  for (const key of SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value !== 'string') continue
    const text = oneLine(value, key === 'prompt' ? max : 120)
    if (!text) continue
    lines.push(text)
    if (lines.length >= 2) return lines
  }
  if (lines.length > 0) return lines
  for (const [key, value] of Object.entries(input)) {
    if (HIDDEN_SUMMARY_KEYS.has(key)) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue
    }
    const text = oneLine(String(value), 120)
    if (!text) continue
    lines.push(`${key}: ${text}`)
    if (lines.length >= 3) break
  }
  return lines
}

export interface DecisionCounts {
  allow: number
  deny: number
}

/**
 * "You have allowed this exact command N times before." Only real allow/deny
 * decisions count; terminal handoffs and timeouts are not evidence either way.
 */
export function decisionCounts(
  records: readonly ApprovalRecord[],
  tool: string,
  command: string
): DecisionCounts {
  const wanted = command.trim()
  if (!wanted) return { allow: 0, deny: 0 }
  const normalizedTool = tool.trim().toLowerCase()
  let allow = 0
  let deny = 0
  for (const record of records) {
    if (record.tool.trim().toLowerCase() !== normalizedTool) continue
    if (record.command.trim() !== wanted) continue
    if (record.decision === 'allow') allow += 1
    else if (record.decision === 'deny') deny += 1
  }
  return { allow, deny }
}

/** Compact wait clock used in the popup header: 12s, 3m 40s, 2h 05m. */
export function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, '0')}m`
}

/** Keep in sync with the Python hooks; protects against older hook versions. */
const CONFIRMATION_ONLY = new Set([
  '继续',
  '继续吧',
  '继续执行',
  '继续做',
  '接着',
  '好的',
  '好的继续',
  '好',
  '好继续',
  '可以',
  '可以继续',
  '行',
  '嗯',
  '嗯嗯',
  '对',
  '是',
  '是的',
  '没问题',
  '辛苦了',
  '谢谢',
  'ok',
  'okay',
  'sure',
  'yes',
  'y',
  'go',
  'go on',
  'continue',
  'proceed',
  'run it',
  'do it',
  'sounds good',
  'lgtm'
])

/**
 * A bare "继续/ok" is a user message but not a task. Older hooks may still send
 * it as `task`; falling back to the session name is better than a headline that
 * says the session is working on "继续".
 */
export function isConfirmationOnly(text: string): boolean {
  const probe = text
    .replace(/[!！。,.，?？~～、；;：:]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return CONFIRMATION_ONLY.has(probe)
}
