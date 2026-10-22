import { describe, expect, it } from 'vitest'
import type { LogEntry, LogLevel } from '../../shared/types'
import { countNewLogs, tailLogId } from './log-delta'

function log(id: string, ts = 0, level: LogLevel = 'info'): LogEntry {
  return { id, ts, level, text: id }
}

describe('countNewLogs', () => {
  it('counts entries appended after the previous tail', () => {
    const logs = [log('a'), log('b'), log('c')]
    expect(countNewLogs('a', logs)).toBe(2)
  })

  it('returns 0 when the tail has not changed', () => {
    const logs = [log('a'), log('b')]
    expect(countNewLogs('b', logs)).toBe(0)
  })

  it('keeps counting after the 800-entry cap even when length is unchanged', () => {
    const logs = Array.from({ length: 800 }, (_, index) => log(`id-${index}`))
    const previousTailId = logs[790].id
    expect(countNewLogs(previousTailId, logs)).toBe(9)
  })

  it('falls back to the array length when the previous tail has been rotated out', () => {
    const logs = [log('x'), log('y'), log('z')]
    expect(countNewLogs('gone', logs)).toBe(3)
  })

  it('returns 0 for an empty log list', () => {
    expect(countNewLogs('a', [])).toBe(0)
    expect(countNewLogs(null, [])).toBe(0)
  })

  it('treats a missing previous tail as the first snapshot', () => {
    expect(countNewLogs(null, [log('a'), log('b')])).toBe(2)
  })
})

describe('tailLogId', () => {
  it('returns the id of the last entry', () => {
    expect(tailLogId([log('a'), log('b')])).toBe('b')
  })

  it('returns null for an empty log list', () => {
    expect(tailLogId([])).toBeNull()
  })
})
