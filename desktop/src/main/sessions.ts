import type { ApprovalItem, ApprovalRecord, SessionInfo } from '../shared/types'
import {
  deriveSessionLabel,
  pickSessionColor,
  sessionColor,
  sessionKeyOf
} from '../shared/session'
import {
  loadSessionMeta,
  saveSessionMeta,
  type SessionMeta,
  type SessionMetaMap
} from './config'

const IDLE_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_SESSIONS = 16

export class SessionRegistry {
  private meta: SessionMetaMap

  constructor(meta: SessionMetaMap = loadSessionMeta()) {
    this.meta = meta
  }

  getMeta(): SessionMetaMap {
    return this.meta
  }

  labelFor(key: string, fallback: string): string {
    const custom = this.meta[key]?.label
    if (custom && custom.trim()) return custom
    return fallback
  }

  colorFor(key: string): string {
    return this.meta[key]?.color || sessionColor(key)
  }

  isMuted(key: string, now = Date.now()): boolean {
    const until = this.meta[key]?.mutedUntil
    return typeof until === 'number' && until > now
  }

  observe(item: ApprovalItem): void {
    const key = item.sessionKey
    const previous = this.meta[key] || {}
    this.meta[key] = {
      ...previous,
      sessionId: item.sessionId,
      origin: item.origin,
      project: item.project,
      cwd: item.cwd,
      tty: item.tty,
      terminal: item.terminal,
      lastSeen: Math.max(previous.lastSeen || 0, item.createdAt)
    }
    if (!previous.color) {
      const used = new Set(
        Object.entries(this.meta)
          .filter(([entryKey]) => entryKey !== key)
          .map(([, entry]) => entry.color)
          .filter((color): color is string => Boolean(color))
      )
      this.meta[key] = { ...this.meta[key], color: pickSessionColor(key, used) }
    }
    if (!previous.label) {
      const label =
        item.sessionLabel ||
        deriveSessionLabel({
          project: item.project,
          terminal: item.terminal,
          tty: item.tty,
          sessionId: item.sessionId
        })
      if (label) this.meta[key] = { ...this.meta[key], label }
    }
    this.persist()
  }

  observeSimple(input: {
    sessionId?: string
    origin?: string
    cwd?: string
    project?: string
    tty?: string
    terminal?: string
    at?: number
  }): string | null {
    if (!input.sessionId && !input.cwd) return null
    const key = sessionKeyOf(input)
    const previous = this.meta[key] || {}
    const project = input.project || previous.project || ''
    const label =
      previous.label ||
      deriveSessionLabel({
        project,
        terminal: input.terminal || previous.terminal,
        tty: input.tty || previous.tty,
        sessionId: input.sessionId || previous.sessionId
      })
    this.meta[key] = {
      ...previous,
      sessionId: input.sessionId || previous.sessionId,
      origin: input.origin || previous.origin,
      project,
      cwd: input.cwd || previous.cwd,
      tty: input.tty || previous.tty,
      terminal: input.terminal || previous.terminal,
      label,
      color:
        previous.color ||
        pickSessionColor(
          key,
          new Set(
            Object.entries(this.meta)
              .filter(([entryKey]) => entryKey !== key)
              .map(([, entry]) => entry.color)
              .filter((color): color is string => Boolean(color))
          )
        ),
      lastSeen: Math.max(previous.lastSeen || 0, input.at || Date.now())
    }
    this.persist()
    return key
  }

  rename(key: string, label: string): void {
    const trimmed = label.trim().slice(0, 60)
    if (!trimmed) return
    this.meta[key] = { ...(this.meta[key] || {}), label: trimmed }
    this.persist()
  }

  mute(key: string, minutes: number): void {
    const until = minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0
    this.meta[key] = { ...(this.meta[key] || {}), mutedUntil: until }
    this.persist()
  }

  list(pending: ApprovalItem[], history: ApprovalRecord[], now = Date.now()): SessionInfo[] {
    const keys = new Set<string>()
    for (const item of pending) keys.add(item.sessionKey)
    for (const record of history.slice(0, 40)) keys.add(record.sessionKey)
    for (const key of Object.keys(this.meta)) keys.add(key)

    const sessions: SessionInfo[] = []
    for (const key of keys) {
      const meta: SessionMeta = this.meta[key] || {}
      const waitingItems = pending.filter((item) => item.sessionKey === key)
      const waiting = waitingItems.length
      const latest = waitingItems[0]
      const recent = history.find((record) => record.sessionKey === key)
      const lastSeen = Math.max(
        meta.lastSeen || 0,
        latest?.createdAt || 0,
        recent?.ts || 0
      )
      if (!waiting && lastSeen > 0 && now - lastSeen > IDLE_RETENTION_MS) {
        delete this.meta[key]
        continue
      }
      const label =
        meta.label ||
        latest?.sessionLabel ||
        deriveSessionLabel({
          project: meta.project || recent?.project,
          tty: meta.tty,
          terminal: meta.terminal,
          sessionId: meta.sessionId
        })
      sessions.push({
        key,
        sessionId: meta.sessionId || latest?.sessionId || '',
        origin: meta.origin || latest?.origin || recent?.origin || '本机',
        label,
        project: meta.project || latest?.project || recent?.project || '',
        cwd: meta.cwd || latest?.cwd || '',
        tty: meta.tty || latest?.tty || '',
        terminal: meta.terminal || latest?.terminal || '',
        lastSeen,
        waiting,
        state: waiting > 0 ? 'waiting' : 'idle',
        color: meta.color || sessionColor(key),
        mutedUntil: meta.mutedUntil && meta.mutedUntil > now ? meta.mutedUntil : null
      })
    }

    let recolored = false
    const usedColors = new Set<string>()
    for (const session of sessions) {
      if (usedColors.has(session.color)) {
        const next = pickSessionColor(session.key, usedColors)
        session.color = next
        this.meta[session.key] = { ...(this.meta[session.key] || {}), color: next }
        recolored = true
      }
      usedColors.add(session.color)
    }
    if (recolored) this.persist()

    return sessions
      .sort((left, right) => {
        if ((left.waiting > 0) !== (right.waiting > 0)) return left.waiting > 0 ? -1 : 1
        return right.lastSeen - left.lastSeen
      })
      .slice(0, MAX_SESSIONS)
  }

  private persist(): void {
    try {
      saveSessionMeta(this.meta)
    } catch {
      // session metadata is best-effort
    }
  }
}
