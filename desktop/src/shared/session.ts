import type {
  ApprovalItem,
  ApprovalQuestion,
  RiskInfo,
  RiskLevel,
  SessionInfo
} from './types'

export const SESSION_COLORS = [
  '#e07a5a',
  '#8fd1ae',
  '#8fb3cc',
  '#a3addb',
  '#d2b07a',
  '#d69bb5',
  '#7fc6c3',
  '#b3a0e0'
]

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: '递归强制删除' },
  { pattern: /\brm\s+-rf?\s+\/(?:\s|$)/i, reason: '删除根目录' },
  { pattern: /\bsudo\b/i, reason: '提权执行' },
  { pattern: /\bdoas\b/i, reason: '提权执行' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: '格式化文件系统' },
  { pattern: /\bdd\s+[^\n]*\bof=/i, reason: '直接写块设备' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: '关机/重启' },
  { pattern: /\bchmod\s+(-[a-z]*r[a-z]*\s+)?777\b/i, reason: '开放全部权限' },
  { pattern: /\bchown\s+(-[a-z]*r[a-z]*\s+)?[^\s]+\s+\/(?:\s|$)/i, reason: '修改根目录归属' },
  { pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, reason: '远程脚本直接执行' },
  { pattern: /\bgit\s+push\b[^\n]*--force\b/i, reason: '强制推送' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '丢弃本地修改' },
  { pattern: /\bgit\s+clean\b[^\n]*-[a-z]*f/i, reason: '强制清理未跟踪文件' },
  { pattern: /\b(drop\s+table|truncate\s+table|delete\s+from)\b/i, reason: '破坏性数据库操作' },
  { pattern: /\b(kill|pkill|killall)\b[^\n]*-9?\b/i, reason: '强制终止进程' },
  { pattern: /\bdocker\s+(rm|rmi)\b[^\n]*-f\b/i, reason: '强制删除容器/镜像' },
  { pattern: /\bkubectl\s+delete\b/i, reason: '删除集群资源' },
  { pattern: /\bterraform\s+destroy\b/i, reason: '销毁基础设施' },
  { pattern: /\baws\b[^\n]*\bdelete-/i, reason: '删除云资源' },
  { pattern: /\bnpm\s+publish\b/i, reason: '发布 npm 包' },
  { pattern: /\b(remove-item|del|rmdir)\b[^\n]*-r[a-z]*\s+-f/i, reason: '递归强制删除' },
  { pattern: />\s*\/dev\/sd[a-z]/i, reason: '写入磁盘设备' }
]

const MEDIUM_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b/i, reason: '推送到远端' },
  { pattern: /\bgit\s+(commit|merge|rebase|cherry-pick)\b/i, reason: '改写提交历史' },
  { pattern: /\b(npm|pnpm|yarn)\s+(install|add|remove|upgrade)\b/i, reason: '修改依赖' },
  { pattern: /\b(pip|pip3|poetry|uv)\s+(install|add|remove)\b/i, reason: '修改依赖' },
  { pattern: /\bdocker\b/i, reason: '容器操作' },
  { pattern: /\bkubectl\b/i, reason: '集群操作' },
  { pattern: /\bterraform\b/i, reason: '基础设施操作' },
  { pattern: /\b(chmod|chown)\b/i, reason: '修改文件权限' },
  { pattern: /\b(mv|cp|rm|rmdir)\b/i, reason: '修改/删除文件' },
  { pattern: /\b(curl|wget|ssh|scp|rsync)\b/i, reason: '网络访问' },
  { pattern: /(^|\s)>\s*[^\s/]/i, reason: '覆盖写入文件' },
  { pattern: /\b(export|setx)\s+\w*(TOKEN|KEY|SECRET|PASSWORD)/i, reason: '写入敏感环境变量' }
]

const SENSITIVE_PATH = /(\.env(\.|$)|\.git\/|\.ssh\/|id_rsa|id_ed25519|authorized_keys|\.aws\/|\.npmrc|\.pypirc|credentials|secrets?\.(json|ya?ml|toml))/i

export function projectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '')
  if (!normalized) return '未知项目'
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || normalized
}

export function shortPath(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  if (parts.length <= 2) return cwd
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export function sessionKeyOf(input: {
  origin?: string
  sessionId?: string
  cwd?: string
  tty?: string
}): string {
  const origin = (input.origin || '本机').trim() || '本机'
  const sessionId = (input.sessionId || '').trim()
  if (sessionId) return `${origin}:${sessionId}`
  const cwd = (input.cwd || '').trim()
  const tty = (input.tty || '').trim()
  if (cwd || tty) return `${origin}:${cwd}:${tty}`
  return `${origin}:unknown`
}

export function deriveSessionLabel(input: {
  project?: string
  terminal?: string
  tty?: string
  sessionId?: string
}): string {
  const project = (input.project || '').trim() || '未知项目'
  const suffix = (input.tty || input.terminal || '').trim()
  if (suffix) return `${project} · ${suffix}`
  const sessionId = (input.sessionId || '').trim()
  if (sessionId) return `${project} · ${sessionId.slice(0, 4)}`
  return project
}

export function pickSessionColor(key: string, used: Set<string>): string {
  const preferred = sessionColor(key)
  if (!used.has(preferred)) return preferred
  const start = SESSION_COLORS.indexOf(preferred)
  for (let offset = 1; offset <= SESSION_COLORS.length; offset += 1) {
    const candidate = SESSION_COLORS[(start + offset) % SESSION_COLORS.length]
    if (!used.has(candidate)) return candidate
  }
  return preferred
}

export function sessionColor(key: string): string {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }
  return SESSION_COLORS[hash % SESSION_COLORS.length]
}

export function sortByDeadline<T extends { timeoutAt: number; createdAt: number }>(
  items: T[]
): T[] {
  return [...items].sort((left, right) => {
    if (left.timeoutAt !== right.timeoutAt) return left.timeoutAt - right.timeoutAt
    return left.createdAt - right.createdAt
  })
}

export function groupBySession<T extends { sessionKey: string; timeoutAt: number; createdAt: number }>(
  items: T[]
): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(item.sessionKey)
    if (group) group.push(item)
    else groups.set(item.sessionKey, [item])
  }
  return [...groups.entries()].map(([key, groupItems]) => ({
    key,
    items: sortByDeadline(groupItems)
  }))
}

export function remainingSeconds(timeoutAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((timeoutAt - now) / 1000))
}

export function commandText(toolInput: Record<string, unknown>): string {
  const command = toolInput.command
  if (typeof command === 'string' && command.trim()) return command
  const filePath = toolInput.file_path || toolInput.path || toolInput.notebook_path
  if (typeof filePath === 'string' && filePath.trim()) return filePath
  const url = toolInput.url
  if (typeof url === 'string' && url.trim()) return url
  return ''
}

export function prettyToolInput(toolInput: Record<string, unknown>): string {
  try {
    return JSON.stringify(toolInput, null, 2)
  } catch {
    return String(toolInput)
  }
}

export function extractEditDiff(toolInput: Record<string, unknown>): {
  filePath: string
  oldText: string
  newText: string
} | null {
  const filePath = toolInput.file_path || toolInput.path
  if (typeof filePath !== 'string' || !filePath) return null
  const oldText =
    typeof toolInput.old_string === 'string'
      ? toolInput.old_string
      : typeof toolInput.old_str === 'string'
        ? toolInput.old_str
        : ''
  const newText =
    typeof toolInput.new_string === 'string'
      ? toolInput.new_string
      : typeof toolInput.new_str === 'string'
        ? toolInput.new_str
        : typeof toolInput.content === 'string'
          ? toolInput.content
          : ''
  if (!oldText && !newText) return null
  return { filePath, oldText, newText }
}

export function assessRisk(
  tool: string,
  toolInput: Record<string, unknown>
): RiskInfo {
  const reasons: string[] = []
  const command = commandText(toolInput)
  const haystack = command || prettyToolInput(toolInput)
  const normalizedTool = tool.toLowerCase()

  for (const entry of HIGH_RISK_PATTERNS) {
    if (entry.pattern.test(haystack)) reasons.push(entry.reason)
  }
  if (SENSITIVE_PATH.test(haystack)) reasons.push('触及敏感路径')
  if (/(^|\s)--no-verify\b/i.test(haystack)) reasons.push('跳过校验钩子')

  if (reasons.length > 0) {
    return { level: 'high', reasons: [...new Set(reasons)].slice(0, 4) }
  }

  for (const entry of MEDIUM_RISK_PATTERNS) {
    if (entry.pattern.test(haystack)) reasons.push(entry.reason)
  }
  if (normalizedTool === 'write' || normalizedTool === 'edit' || normalizedTool === 'multiedit') {
    reasons.push('修改文件内容')
  }
  if (normalizedTool === 'bash' && /(^|\s)(npm|pnpm|yarn)\s+test\b/i.test(haystack)) {
    return { level: 'low', reasons: [] }
  }
  if (reasons.length > 0) {
    return { level: 'medium', reasons: [...new Set(reasons)].slice(0, 3) }
  }
  return { level: 'low', reasons: [] }
}

export function riskRank(level: RiskLevel): number {
  return level === 'high' ? 2 : level === 'medium' ? 1 : 0
}

export function riskLabel(level: RiskLevel): string {
  return level === 'high' ? '高风险' : level === 'medium' ? '需留意' : '低风险'
}

export interface RiskSegment {
  text: string
  danger: boolean
}

const DANGER_TOKEN =
  /(\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b|\bsudo\b|\bmkfs(?:\.\w+)?\b|\bdd\s+[^\n]*\bof=|\b(shutdown|reboot|halt|poweroff)\b|\bchmod\s+(?:-[a-z]*r[a-z]*\s+)?777\b|\bgit\s+push\b[^\n]*--force\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\b[^\n]*-[a-z]*f|\b(?:drop\s+table|truncate\s+table|delete\s+from)\b|\b(?:kill|pkill|killall)\b[^\n]*-9|\bdocker\s+(?:rm|rmi)\b[^\n]*-f|\bkubectl\s+delete\b|\bterraform\s+destroy\b|\bnpm\s+publish\b|--force(?:-with-lease)?|--no-verify)/gi

export function riskSegments(command: string): RiskSegment[] {
  const segments: RiskSegment[] = []
  let lastIndex = 0
  for (const match of command.matchAll(DANGER_TOKEN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      segments.push({ text: command.slice(lastIndex, index), danger: false })
    }
    segments.push({ text: match[0], danger: true })
    lastIndex = index + match[0].length
  }
  if (lastIndex < command.length) {
    segments.push({ text: command.slice(lastIndex), danger: false })
  }
  return segments.length > 0 ? segments : [{ text: command, danger: false }]
}

export function questionSummary(questions: ApprovalQuestion[]): string {
  if (questions.length === 0) return ''
  return questions.map((question) => question.question).join(' / ').slice(0, 160)
}

export function approvalCommand(item: ApprovalItem): string {
  const command = commandText(item.toolInput)
  if (command) return command
  if (item.kind === 'question') {
    return questionSummary(item.questions) || item.message
  }
  const detail = item.detail.trim()
  if (detail && !detail.startsWith('{') && !detail.startsWith('[')) {
    return detail.split('\n')[0]
  }
  return item.message
}

export function summaryOfSession(
  items: ApprovalItem[],
  key: string
): SessionInfo | null {
  const first = items.find((item) => item.sessionKey === key)
  if (!first) return null
  return {
    key,
    sessionId: first.sessionId,
    origin: first.origin,
    label: first.sessionLabel,
    project: first.project,
    cwd: first.cwd,
    tty: first.tty,
    terminal: first.terminal,
    lastSeen: first.createdAt,
    waiting: items.filter((item) => item.sessionKey === key).length,
    state: 'waiting',
    color: sessionColor(key),
    mutedUntil: null
  }
}
