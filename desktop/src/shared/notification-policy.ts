/**
 * Pure policy for OS-level notifications. Keeping this out of the Electron main
 * process makes the switch/mute interactions testable without a running app.
 */
import type { DeployMode } from './types'

export interface SystemNotificationGate {
  /** Capture/self-test runs have no visible notification surface. */
  headless: boolean
  /** User preference `prefs.systemNotifications`. */
  enabled: boolean
  /** Per-session mute (`sessions.isMuted(key)`). */
  muted: boolean
  /** `Notification.isSupported()` on the current platform. */
  supported: boolean
  /** True when the local clock is inside the user's quiet-hours window. */
  quietHours?: boolean
  /** High-risk approvals are allowed to break through quiet hours. */
  highRisk?: boolean
}

export function canDeliverSystemNotification(gate: SystemNotificationGate): boolean {
  if (gate.headless || !gate.enabled || gate.muted || !gate.supported) return false
  if (gate.quietHours && !gate.highRisk) return false
  return true
}

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Whether a local timestamp falls inside an HH:mm window (overnight supported). */
export function isWithinQuietHours(
  timestamp: number,
  start: string,
  end: string
): boolean {
  const from = parseClock(start)
  const to = parseClock(end)
  if (from === null || to === null || from === to) return false
  const date = new Date(timestamp)
  const current = date.getHours() * 60 + date.getMinutes()
  if (from < to) return current >= from && current < to
  return current >= from || current < to
}

export interface CompletionPopupGate {
  isStop: boolean
  mode: DeployMode
  headless: boolean
  muted: boolean
  hasPending: boolean
}

/**
 * In popup mode a completed turn gets the in-app window. Notify mode keeps the
 * OS toast. Pending approvals already own the popup, so don't replace them.
 */
export function shouldShowCompletionPopup(gate: CompletionPopupGate): boolean {
  return gate.isStop && gate.mode === 'popup' && !gate.headless && !gate.muted && !gate.hasPending
}
