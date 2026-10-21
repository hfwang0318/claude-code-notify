export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
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
  deploy: 'DEPLOY'
}
