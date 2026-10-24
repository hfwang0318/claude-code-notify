import { describe, expect, it } from 'vitest'
import {
  canDeliverSystemNotification,
  isWithinQuietHours,
  shouldShowCompletionPopup,
  type CompletionPopupGate,
  type SystemNotificationGate
} from './notification-policy'

function gate(overrides: Partial<SystemNotificationGate> = {}): SystemNotificationGate {
  return {
    headless: false,
    enabled: true,
    muted: false,
    supported: true,
    ...overrides
  }
}

describe('system notification policy', () => {
  it('delivers when every gate is open', () => {
    expect(canDeliverSystemNotification(gate())).toBe(true)
  })

  it('never delivers in headless mode', () => {
    expect(canDeliverSystemNotification(gate({ headless: true }))).toBe(false)
  })

  it('does not deliver when the system notification preference is off', () => {
    expect(canDeliverSystemNotification(gate({ enabled: false }))).toBe(false)
  })

  it('does not deliver for a muted session', () => {
    expect(canDeliverSystemNotification(gate({ muted: true }))).toBe(false)
  })

  it('does not deliver when the platform does not support notifications', () => {
    expect(canDeliverSystemNotification(gate({ supported: false }))).toBe(false)
  })

  it('requires all four gates even when three are open', () => {
    expect(canDeliverSystemNotification(gate({ enabled: false, muted: true }))).toBe(false)
    expect(canDeliverSystemNotification(gate({ headless: true, supported: false }))).toBe(false)
  })

  it('suppresses quiet-hours notifications except for high risk', () => {
    expect(canDeliverSystemNotification(gate({ quietHours: true }))).toBe(false)
    expect(canDeliverSystemNotification(gate({ quietHours: true, highRisk: true }))).toBe(true)
  })
})

describe('quiet hours', () => {
  const at = (hour: number, minute = 0): number => {
    const date = new Date(2026, 0, 1, hour, minute, 0, 0)
    return date.getTime()
  }

  it('handles daytime and overnight windows', () => {
    expect(isWithinQuietHours(at(12), '09:00', '18:00')).toBe(true)
    expect(isWithinQuietHours(at(8), '09:00', '18:00')).toBe(false)
    expect(isWithinQuietHours(at(23), '22:00', '08:00')).toBe(true)
    expect(isWithinQuietHours(at(7, 59), '22:00', '08:00')).toBe(true)
    expect(isWithinQuietHours(at(8), '22:00', '08:00')).toBe(false)
  })

  it('ignores invalid or empty windows', () => {
    expect(isWithinQuietHours(at(12), '25:00', '08:00')).toBe(false)
    expect(isWithinQuietHours(at(12), '09:00', '09:00')).toBe(false)
    expect(isWithinQuietHours(at(12), '', '08:00')).toBe(false)
  })
})

describe('completion popup policy', () => {
  function popupGate(overrides: Partial<CompletionPopupGate> = {}): CompletionPopupGate {
    return {
      isStop: true,
      mode: 'popup',
      headless: false,
      muted: false,
      hasPending: false,
      ...overrides
    }
  }

  it('shows the in-app completion popup in popup mode', () => {
    expect(shouldShowCompletionPopup(popupGate())).toBe(true)
  })

  it('does not show for non-Stop notifications, notify mode, mute, headless, or pending approvals', () => {
    expect(shouldShowCompletionPopup(popupGate({ isStop: false }))).toBe(false)
    expect(shouldShowCompletionPopup(popupGate({ mode: 'notify' }))).toBe(false)
    expect(shouldShowCompletionPopup(popupGate({ muted: true }))).toBe(false)
    expect(shouldShowCompletionPopup(popupGate({ headless: true }))).toBe(false)
    expect(shouldShowCompletionPopup(popupGate({ hasPending: true }))).toBe(false)
  })
})
