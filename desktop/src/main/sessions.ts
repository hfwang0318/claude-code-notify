import type { ApprovalItem, ApprovalRecord, SessionInfo } from '../shared/types'
import {
  deriveSessionLabel,
  pickSessionColor,
  sessionColor,
  sessionKeyOf,
  shortSessionId,
  taskTitle
} from '../shared/session'
import {
  loadSessionMeta,
  saveSessionMeta,
  type SessionMeta,
  type SessionMetaMap
} from './config'

const IDLE_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_SESSIONS = 16
const PERSIST_DEBOUNCE_MS = 200

export class SessionRegistry {
  private meta: SessionMetaMap
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(meta: SessionMetaMap = loadSessionMeta()) {
    this.meta = meta
  }

  /** Write pending metadata changes immediately (used on shutdown/tests). */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      saveSessionMeta(this.meta)
    } catch {
      // session metadata is best-effort
    }
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
    const task = (item.task || '').trim().slice(0, 160)
    const branch = (item.branch || '').trim().slice(0, 80)
    // The name is a first-task snapshot; later task updates only move the
    // task line. A custom rename always wins over this auto title.
    const topic =
      previous.topic ||
      (previous.labelSource === 'custom' ? '' : taskTitle(task))
    this.meta[key] = {
      ...previous,
      sessionId: item.sessionId || previous.sessionId,
      origin: item.origin,
      project: item.project,
      cwd: item.cwd,
      tty: item.tty,
      terminal: item.terminal,
      // Keep the last known task/branch: an older hook (or a payload without
      // transcript context) must not erase what a newer one already reported.
      task: task || previous.task,
      topic,
      branch: branch || previous.branch,
      firstSeen: previous.firstSeen || item.createdAt || Date.now(),
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
      if (label) this.meta[key] = { ...this.meta[key], label, labelSource: 'auto' }
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
    task?: string
    branch?: string
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
    const task = (input.task || '').trim().slice(0, 160)
    const branch = (input.branch || '').trim().slice(0, 80)
    const topic =
      previous.topic ||
      (previous.labelSource === 'custom' ? '' : taskTitle(task))
    this.meta[key] = {
      ...previous,
      sessionId: input.sessionId || previous.sessionId,
      origin: input.origin || previous.origin,
      project,
      cwd: input.cwd || previous.cwd,
      tty: input.tty || previous.tty,
      terminal: input.terminal || previous.terminal,
      task: task || previous.task,
      topic,
      branch: branch || previous.branch,
      label,
      labelSource: previous.labelSource || 'auto',
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
      firstSeen: previous.firstSeen || input.at || Date.now(),
      lastSeen: Math.max(previous.lastSeen || 0, input.at || Date.now())
    }
    this.persist()
    return key
  }

  rename(key: string, label: string): void {
    const trimmed = label.trim().slice(0, 60)
    if (!trimmed) return
    this.meta[key] = { ...(this.meta[key] || {}), label: trimmed, labelSource: 'custom' }
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
    let removedExpired = false
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
        removedExpired = true
        continue
      }
      const project = meta.project || latest?.project || recent?.project || ''
      const derivedLabel = deriveSessionLabel({
        project,
        tty: meta.tty,
        terminal: meta.terminal,
        sessionId: meta.sessionId
      })
      const label = meta.label || latest?.sessionLabel || derivedLabel
      // Legacy data has no labelSource. If the stored label still equals the
      // derived one it was automatic; otherwise the user renamed the session.
      const customLabel = meta.label
        ? meta.labelSource
          ? meta.labelSource === 'custom'
          : meta.label !== derivedLabel
        : false
      const sessionId = meta.sessionId || latest?.sessionId || ''
      sessions.push({
        key,
        sessionId,
        origin: meta.origin || latest?.origin || recent?.origin || '本机',
        label,
        title: label,
        topic: meta.topic || '',
        shortId: shortSessionId(sessionId),
        task: meta.task || latest?.task || '',
        branch: meta.branch || latest?.branch || '',
        ordinal: 1,
        groupSize: 1,
        firstSeen: meta.firstSeen || meta.lastSeen || latest?.createdAt || recent?.ts || 0,
        customLabel,
        project,
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

    let changed = false
    const usedColors = new Set<string>()
    for (const session of sessions) {
      if (usedColors.has(session.color)) {
        const next = pickSessionColor(session.key, usedColors)
        session.color = next
        this.meta[session.key] = { ...(this.meta[session.key] || {}), color: next }
        changed = true
      }
      usedColors.add(session.color)
    }
    if (changed || removedExpired) this.persist()

    const visible = sessions
      .sort((left, right) => {
        if ((left.waiting > 0) !== (right.waiting > 0)) return left.waiting > 0 ? -1 : 1
        return right.lastSeen - left.lastSeen
      })
      .slice(0, MAX_SESSIONS)

    // Number sessions that are *currently waiting* in the same project, so two
    // checkouts of the same repo stop presenting as identical twins. Idle
    // sessions restored from sessions.json must not inflate today's numbers.
    const groups = new Map<string, SessionInfo[]>()
    for (const session of visible) {
      if (session.waiting <= 0) continue
      const groupKey = `${session.origin}\u0000${session.project || session.label}`
      const group = groups.get(groupKey)
      if (group) group.push(session)
      else groups.set(groupKey, [session])
    }
    for (const session of visible) {
      const base = session.project || session.label || '未知项目'
      const group = session.waiting > 0
        ? groups.get(`${session.origin}\u0000${session.project || session.label}`)
        : undefined
      if (!group || group.length <= 1) {
        session.ordinal = 1
        session.groupSize = 1
        session.title = session.customLabel ? session.label : session.topic || base
        continue
      }
      group.sort((left, right) => left.firstSeen - right.firstSeen || left.key.localeCompare(right.key))
      const index = group.findIndex((entry) => entry.key === session.key)
      session.ordinal = index + 1
      session.groupSize = group.length
      session.title = session.customLabel
        ? session.label
        : session.topic || `${base} #${index + 1}`
    }

    return visible
  }

  private persist(): void {
    this.dirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flush()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }
}
