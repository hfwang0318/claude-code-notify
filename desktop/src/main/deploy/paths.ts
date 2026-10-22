import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function hooksDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'hooks')
    : join(app.getAppPath(), 'resources', 'hooks')
}

export function localClaudeDir(): string {
  return process.env.CLAUDE_NOTIFY_CLAUDE_DIR || join(homedir(), '.claude')
}

export function timestamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
