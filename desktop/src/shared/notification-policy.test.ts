import { describe, expect, it } from 'vitest'
import {
  canDeliverSystemNotification,
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
