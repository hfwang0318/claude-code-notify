export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds}s 前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m 前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h 前`
  return `${Math.round(hours / 24)}d 前`
}

export function maskToken(token: string): string {
  if (token.length <= 12) return token
  return `${token.slice(0, 7)}••••${token.slice(-4)}`
}

export function firstLine(value: string): string {
  return (
    value
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  )
}

export const LEVEL_LABEL: Record<string, string> = {
  info: 'INFO',
  notify: 'NOTIFY',
  warn: 'WARN',
  error: 'ERROR',
  allow: 'ALLOW',
  deny: 'DENY',
  timeout: 'TIMEOUT',
  cancelled: 'CANCEL',
  ask: 'ASK',
  answer: 'ANSWER',
  suggestion: 'SUGGEST',
  rule: 'RULE',
  deploy: 'DEPLOY'
}

export const DECISION_LABEL: Record<string, string> = {
  allow: '允许',
  deny: '拒绝',
  ask: '交给终端',
  timeout: '超时回退',
  cancelled: '终端已处理',
  suggestion: '权限建议',
  answer: '桌面回答'
}

export const SOURCE_LABEL: Record<string, string> = {
  popup: '弹窗',
  terminal: '终端',
  timeout: '超时',
  rule: '规则',
  admission: '准入',
  'server-stop': '服务停止',
  test: '测试'
}

export const RISK_LABEL: Record<string, string> = {
  low: '低风险',
  medium: '需留意',
  high: '高风险'
}
