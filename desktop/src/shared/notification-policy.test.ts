import { describe, expect, it } from 'vitest'
import {
  canDeliverSystemNotification,
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
