import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRecord } from '../shared/types'

// history.ts imports appDataDir()/ensureDataDir() from config.ts, which imports
// Electron at module load time. Tests only need the data-directory helpers.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  }
}))

import { HistoryStore, historyFilePath } from './history'

const BASE_TS = new Date('2026-01-01T00:00:00.000Z').getTime()

function makeRecord(index: number): ApprovalRecord {
  return {
    id: `record-${index}`,
    ts: BASE_TS + index * 60_000,
    sessionKey: `session-${index % 3}`,
    sessionLabel: `Session ${index % 3}`,
    origin: 'local',
    project: '/tmp/claude-notify-project',
    tool: 'Bash',
    message: `message ${index}`,
    command: index === 42 ? 'echo "hello, world"' : `echo ${index}`,
    decision: index % 2 === 0 ? 'allow' : 'deny',
    source: 'popup',
    latencyMs: 100 + index,
    risk: index % 3 === 0 ? 'high' : 'low'
  }
}

describe('HistoryStore.exportCsv', () => {
  let dataDir: string
  let previousDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-notify-history-'))
    previousDataDir = process.env.CLAUDE_NOTIFY_DATA_DIR
    process.env.CLAUDE_NOTIFY_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.CLAUDE_NOTIFY_DATA_DIR
    } else {
      process.env.CLAUDE_NOTIFY_DATA_DIR = previousDataDir
    }
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('exports the full on-disk history instead of the 300 in-memory records', () => {
    expect(historyFilePath()).toBe(join(dataDir, 'history.jsonl'))

    const writer = new HistoryStore()
    for (let index = 0; index < 350; index += 1) writer.append(makeRecord(index))

    const reader = new HistoryStore()
    expect(reader.load()).toHaveLength(300)

    const target = join(dataDir, 'history.csv')
    expect(reader.exportCsv(target)).toBe(350)

    const lines = readFileSync(target, 'utf-8').trimEnd().split('\n')
    expect(lines).toHaveLength(351)
    expect(lines[0]).toBe(
      'time,session,origin,project,tool,decision,source,latency_ms,risk,command'
    )

    // The file stays in chronological (oldest → newest) order and includes the
    // 50 records that had already fallen out of the in-memory window.
    expect(lines[1].startsWith(new Date(makeRecord(0).ts).toISOString())).toBe(true)
    expect(lines[350].startsWith(new Date(makeRecord(349).ts).toISOString())).toBe(true)

    const escapedLine = lines.find((line) => line.includes('hello'))
    expect(escapedLine).toBeDefined()
    expect(escapedLine).toContain('"echo ""hello, world"""')
    expect(escapedLine?.endsWith('"echo ""hello, world"""')).toBe(true)
  })

  it('falls back to in-memory records when the history file cannot be read', () => {
    // A directory at the history path makes readFileSync fail.
    mkdirSync(historyFilePath(), { recursive: true })

    const store = new HistoryStore()
    store.append(makeRecord(0))
    store.append(makeRecord(1))
    expect(store.get()).toHaveLength(2)

    const target = join(dataDir, 'fallback.csv')
    expect(store.exportCsv(target)).toBe(2)

    const lines = readFileSync(target, 'utf-8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1].startsWith(new Date(makeRecord(0).ts).toISOString())).toBe(true)
    expect(lines[2].startsWith(new Date(makeRecord(1).ts).toISOString())).toBe(true)
  })

  it('exports the on-disk history as JSON', () => {
    const writer = new HistoryStore()
    writer.append(makeRecord(0))
    writer.append(makeRecord(1))
    const target = join(dataDir, 'history.json')
    expect(writer.exportJson(target)).toBe(2)
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as ApprovalRecord[]
    expect(parsed).toHaveLength(2)
    expect(parsed[0].id).toBe('record-0')
    expect(parsed[1].id).toBe('record-1')
  })
})
