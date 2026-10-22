import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalItem } from '../shared/types'

// sessions.ts -> config.ts imports Electron at module load time. These tests
// only exercise the data-directory helpers, so stub the electron surface.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  }
}))

import { SessionRegistry } from './sessions'

function sessionFilePath(dir: string): string {
  return join(dir, 'sessions.json')
}

function readMeta(dir: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(sessionFilePath(dir), 'utf-8')) as Record<
    string,
    Record<string, unknown>
  >
}

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'apr_test',
    requestId: 'req_test',
    sessionId: 'session-a',
    sessionKey: '本机:session-a',
    sessionLabel: 'demo · a',
    origin: '本机',
    promptId: '',
    toolUseId: '',
    transcriptPath: '',
    kind: 'permission',
    tool: 'Bash',
    project: 'demo',
    cwd: '/tmp/demo',
    tty: '',
    terminal: '',
    message: 'test',
    detail: '{}',
    toolInput: {},
    options: [],
    suggestions: [],
    questions: [],
    risk: { level: 'low', reasons: [] },
    correlation: 'exact',
    createdAt: 1_000,
    timeoutAt: 61_000,
    timeoutSec: 60,
    ...overrides
  }
}

describe('SessionRegistry persistence', () => {
  let dir: string
  let previousDataDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-notify-sessions-'))
    previousDataDir = process.env.CLAUDE_NOTIFY_DATA_DIR
    process.env.CLAUDE_NOTIFY_DATA_DIR = dir
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CLAUDE_NOTIFY_DATA_DIR
    else process.env.CLAUDE_NOTIFY_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps observe() off the disk until flush()', () => {
    const registry = new SessionRegistry()
    registry.observe(makeItem())

    expect(existsSync(sessionFilePath(dir))).toBe(false)

    registry.flush()

    const saved = readMeta(dir)
    expect(saved['本机:session-a']).toMatchObject({
      sessionId: 'session-a',
      project: 'demo',
      cwd: '/tmp/demo'
    })
    expect(saved['本机:session-a'].label).toBeTruthy()
    expect(saved['本机:session-a'].color).toBeTruthy()
  })

  it('debounces observeSimple/rename/mute writes and flushes them together', () => {
    const registry = new SessionRegistry()
    registry.observeSimple({ sessionId: 'session-b', project: 'demo', cwd: '/tmp/demo' })
    registry.rename('本机:session-b', 'Renamed session')
    registry.mute('本机:session-b', 15)

    expect(existsSync(sessionFilePath(dir))).toBe(false)

    registry.flush()

    const saved = readMeta(dir)
    expect(saved['本机:session-b']).toMatchObject({
      label: 'Renamed session',
      project: 'demo'
    })
    expect(typeof saved['本机:session-b'].mutedUntil).toBe('number')
  })

  it('persists expired-session deletion from list()', () => {
    const now = 10 * 24 * 60 * 60 * 1000
    writeFileSync(
      sessionFilePath(dir),
      JSON.stringify(
        {
          '本机:stale': {
            label: 'Stale',
            project: 'demo',
            lastSeen: now - 2 * 24 * 60 * 60 * 1000
          },
          '本机:fresh': {
            label: 'Fresh',
            project: 'demo',
            lastSeen: now - 60_000
          }
        },
        null,
        2
      ),
      'utf-8'
    )

    const registry = new SessionRegistry()
    const listed = registry.list([], [], now)
    expect(listed.map((session) => session.key)).toEqual(['本机:fresh'])
    expect(registry.getMeta()['本机:stale']).toBeUndefined()

    // The removal is debounced like every other metadata mutation.
    expect(readMeta(dir)['本机:stale']).toBeDefined()

    registry.flush()

    const saved = readMeta(dir)
    expect(saved['本机:stale']).toBeUndefined()
    expect(saved['本机:fresh']).toBeDefined()
  })

  it('writes the latest state once the debounce window elapses', async () => {
    const registry = new SessionRegistry()
    registry.rename('本机:session-c', 'First')
    registry.rename('本机:session-c', 'Second')

    await new Promise((resolve) => setTimeout(resolve, 350))

    const saved = readMeta(dir)
    expect(saved['本机:session-c'].label).toBe('Second')
  })
})
