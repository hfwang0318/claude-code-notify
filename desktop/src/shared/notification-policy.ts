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
}

export function canDeliverSystemNotification(gate: SystemNotificationGate): boolean {
  return !gate.headless && gate.enabled && !gate.muted && gate.supported
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
