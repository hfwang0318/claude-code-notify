/**
 * Pure policy for OS-level notifications. Keeping this out of the Electron main
 * process makes the switch/mute interactions testable without a running app.
 */
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
