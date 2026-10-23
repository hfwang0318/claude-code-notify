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
    task: '',
    branch: '',
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

  it('uses the first task as the session name and keeps later topics in the task line', () => {
    const registry = new SessionRegistry()
    const first = makeItem({
      sessionId: '3c9f0000-0000-4000-8000-000000000001',
      sessionKey: '本机:3c9f',
      sessionLabel: 'claude-code-notify · ttys001',
      project: 'claude-code-notify',
      cwd: '/work/a',
      tty: 'ttys001',
      task: '修复多会话弹窗无法区分任务的问题',
      branch: 'feat/popup-identity',
      createdAt: 1000
    })
    const second = makeItem({
      id: 'apr_second',
      sessionId: '81bd0000-0000-4000-8000-000000000002',
      sessionKey: '本机:81bd',
      sessionLabel: 'claude-code-notify · ttys002',
      project: 'claude-code-notify',
      cwd: '/work/b',
      tty: 'ttys002',
      task: '给审批接口补上 trace_id 透传',
      branch: 'fix/trace-id',
      createdAt: 2000
    })
    registry.observe(first)
    registry.observe(second)

    const listed = registry.list([first, second], [], 3000)
    const one = listed.find((session) => session.key === '本机:3c9f')
    const two = listed.find((session) => session.key === '本机:81bd')
    expect(one?.title).toBe('修复多会话弹窗无法区分任务的问题')
    expect(two?.title).toBe('给审批接口补上 trace_id 透传')
    expect(one?.title).not.toBe(two?.title)
    expect(one?.shortId).toBe('3c9f')
    expect(one?.task).toBe('修复多会话弹窗无法区分任务的问题')
    expect(two?.branch).toBe('fix/trace-id')
    expect(one?.groupSize).toBe(2)
    expect(one?.customLabel).toBe(false)

    // A later topic inside the same session updates the task line only; the
    // name is a first-task snapshot, which is what makes `/new` produce a new
    // name while ordinary topic changes do not.
    registry.observe({
      ...first,
      id: 'apr_later',
      task: '排查 staging 部署失败',
      createdAt: 2500
    })
    const after = registry.list([first, second], [], 3000)
    const stillOne = after.find((session) => session.key === '本机:3c9f')
    expect(stillOne?.title).toBe('修复多会话弹窗无法区分任务的问题')
    expect(stillOne?.task).toBe('排查 staging 部署失败')

    registry.flush()
    expect(readMeta(dir)['本机:3c9f']).toMatchObject({
      task: '排查 staging 部署失败',
      topic: '修复多会话弹窗无法区分任务的问题',
      branch: 'feat/popup-identity',
      labelSource: 'auto'
    })
  })

  it('lets a custom name win over automatic numbering', () => {
    const registry = new SessionRegistry()
    const first = makeItem({
      sessionId: 'aaa00000-0000-4000-8000-000000000001',
      sessionKey: '本机:aaa',
      sessionLabel: 'demo · aaa0',
      project: 'demo',
      cwd: '/work/a',
      createdAt: 1000
    })
    const second = makeItem({
      id: 'apr_b',
      sessionId: 'bbb00000-0000-4000-8000-000000000002',
      sessionKey: '本机:bbb',
      sessionLabel: 'demo · bbb0',
      project: 'demo',
      cwd: '/work/b',
      createdAt: 2000
    })
    registry.observe(first)
    registry.observe(second)
    registry.rename('本机:bbb', '后端会话')

    const listed = registry.list([first, second], [], 3000)
    expect(listed.find((session) => session.key === '本机:aaa')?.title).toBe('demo #1')
    const renamed = listed.find((session) => session.key === '本机:bbb')
    expect(renamed?.title).toBe('后端会话')
    expect(renamed?.customLabel).toBe(true)
  })

  it('treats /new (a new session id) as a fresh named session', () => {
    const registry = new SessionRegistry()
    const before = makeItem({
      sessionId: '11110000-0000-4000-8000-000000000001',
      sessionKey: '本机:1111',
      sessionLabel: 'demo · ttys001',
      project: 'demo',
      cwd: '/work/a',
      tty: 'ttys001',
      task: '修复登录跳转',
      createdAt: 1000
    })
    registry.observe(before)

    const afterNew = makeItem({
      id: 'apr_after_new',
      sessionId: '22220000-0000-4000-8000-000000000002',
      sessionKey: '本机:2222',
      sessionLabel: 'demo · ttys001',
      project: 'demo',
      cwd: '/work/a',
      tty: 'ttys001',
      task: '给审批接口补 trace_id',
      createdAt: 2000
    })
    registry.observe(afterNew)

    const listed = registry.list([afterNew], [], 3000)
    expect(listed.find((session) => session.key === '本机:1111')?.title).toBe('修复登录跳转')
    const fresh = listed.find((session) => session.key === '本机:2222')
    expect(fresh?.title).toBe('给审批接口补 trace_id')
    expect(fresh?.shortId).toBe('2222')
    expect(fresh?.title).not.toBe(
      listed.find((session) => session.key === '本机:1111')?.title
    )
  })
})
