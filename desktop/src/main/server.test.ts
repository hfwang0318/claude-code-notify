import { request } from 'node:http'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalItem } from '../shared/types'
import { NotifyServer, type ServerCallbacks } from './server'

const TOKEN = 'test-token'

function rawPost(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; body: string }> {
  const requestHeaders = { ...headers }
  if (body && requestHeaders['Content-Length'] === undefined) {
    requestHeaders['Content-Length'] = String(Buffer.byteLength(body))
  }
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: requestHeaders },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function waitFor<T>(probe: () => T | null, timeout = 3000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timeout')
}

function approvalBody(requestId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    request_id: requestId,
    tool_name: 'Bash',
    cwd: '/tmp/project',
    message: 'test',
    timeout_seconds: 30,
    ...overrides
  })
}

/**
 * Send headers plus half a body over a raw socket and wait for the server to
 * either answer or close. Proves a stalled upload cannot pin the connection.
 */
function halfBodyRequest(
  port: number,
  path: string
): Promise<{ response: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let response = ''
    let settled = false
    const finish = (closed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ response, closed })
    }
    const timer = setTimeout(() => finish(false), 3000)
    socket.on('connect', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          `Authorization: Bearer ${TOKEN}\r\n` +
          'Content-Type: application/json\r\n' +
          'Content-Length: 100\r\n' +
          '\r\n' +
          '{"request_id":"slow'
      )
    })
    socket.on('data', (chunk) => {
      response += chunk.toString('utf-8')
    })
    socket.on('close', () => finish(true))
    socket.on('error', reject)
  })
}

describe('NotifyServer', () => {
  let server: NotifyServer
  let approvals: ApprovalItem[]
  let notifications: number
  let resolutions: Array<{ id: string; decision: string }>
  let callbacks: ServerCallbacks
  let port: number

  beforeEach(async () => {
    approvals = []
    notifications = 0
    resolutions = []
    callbacks = {
      onApproval: (item) => approvals.push(item),
      onResolved: (id, decision) => {
        resolutions.push({ id, decision })
      },
      onNotify: () => {
        notifications += 1
      }
    }
    server = new NotifyServer(0, TOKEN, callbacks)
    await server.start()
    port = server.getPort()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('ignores a duplicate AskUserQuestion permission request', async () => {
    const response = await rawPost(
      port,
      '/claude-approval',
      {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      JSON.stringify({
        request_id: 'question-ghost',
        session_id: 'question-session',
        tool_name: 'AskUserQuestion',
        kind: 'permission',
        timeout_seconds: 30,
        tool_input: { questions: [{ question: 'Which env?', options: [] }] }
      })
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok', decision: 'ask' })
    expect(approvals).toHaveLength(0)
  })

  it('serves health without auth', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'claude-notify' })
  })

  it('rejects missing or wrong bearer tokens', async () => {
    const missing = await rawPost(port, '/claude-approval', { 'Content-Type': 'application/json' }, '{}')
    expect(missing.status).toBe(401)
    const wrong = await rawPost(
      port,
      '/claude-approval',
      { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      '{}'
    )
    expect(wrong.status).toBe(401)
  })

  it('requires content-length', async () => {
    const response = await rawPost(port, '/claude-approval', {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'Transfer-Encoding': 'chunked'
    })
    expect(response.status).toBe(411)
  })

  it('rejects oversized bodies', async () => {
    const body = 'x'.repeat(1024 * 1024 + 10)
    const response = await rawPost(
      port,
      '/claude-approval',
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Length': String(Buffer.byteLength(body))
      },
      body
    )
    expect(response.status).toBe(413)
  })

  it('rejects invalid JSON', async () => {
    const response = await rawPost(
      port,
      '/claude-approval',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      '{oops'
    )
    expect(response.status).toBe(400)
  })

  it('deduplicates notifications for 3 seconds', async () => {
    const payload = JSON.stringify({
      session_id: 's1',
      notification_type: 'permission_prompt',
      message: 'hello'
    })
    for (let index = 0; index < 2; index += 1) {
      const response = await rawPost(
        port,
        '/claude-notify',
        {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`
        },
        payload
      )
      expect(response.status).toBe(200)
    }
    expect(notifications).toBe(1)
  })

  it('holds approval open and returns suggestion extra', async () => {
    const promise = fetch(`http://127.0.0.1:${port}/claude-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        request_id: 'req_suggestion',
        tool_name: 'Bash',
        cwd: '/tmp/project',
        message: 'test',
        timeout_seconds: 30,
        kind: 'permission',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }]
          }
        ]
      })
    })
    const item = await waitFor(() => approvals[0] || null)
    expect(item.suggestions).toHaveLength(1)
    server.respond(item.id, 'suggestion', { index: 0 })
    const response = await promise
    expect(await response.json()).toMatchObject({ status: 'ok', decision: 'suggestion', index: 0 })
  })

  it('returns a user-supplied deny reason to the hook', async () => {
    const promise = fetch(`http://127.0.0.1:${port}/claude-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        request_id: 'req_deny_reason',
        tool_name: 'Bash',
        cwd: '/tmp/project',
        message: 'test',
        timeout_seconds: 30
      })
    })
    const item = await waitFor(() => approvals[0] || null)
    server.respond(item.id, 'deny', { reason: '不要修改生产配置' })
    const response = await promise
    expect(await response.json()).toMatchObject({
      status: 'ok',
      decision: 'deny',
      reason: '不要修改生产配置'
    })
  })

  it('pauses the deadline and resumes without expiring while paused', async () => {
    const promise = fetch(`http://127.0.0.1:${port}/claude-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        request_id: 'req_pause',
        tool_name: 'Bash',
        cwd: '/tmp/project',
        message: 'test',
        timeout_seconds: 5
      })
    })
    const item = await waitFor(() => approvals[0] || null)
    const paused = server.pause(item.id)
    expect(paused?.remainingMs).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(resolutions).toHaveLength(0)
    const resumed = server.resume(item.id)
    expect(resumed?.timeoutAt).toBeGreaterThan(Date.now())
    server.respond(item.id, 'allow')
    expect(await (await promise).json()).toMatchObject({ status: 'ok', decision: 'allow' })
  })

  it('resolves an approval from the terminal', async () => {
    const promise = fetch(`http://127.0.0.1:${port}/claude-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        request_id: 'req_terminal',
        tool_name: 'Edit',
        cwd: '/tmp/project',
        message: 'test',
        timeout_seconds: 30
      })
    })
    await waitFor(() => approvals[0] || null)
    const resolved = await fetch(`http://127.0.0.1:${port}/claude-approval-resolved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ request_id: 'req_terminal' })
    })
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toEqual({ status: 'resolved' })
    expect(await (await promise).json()).toMatchObject({ status: 'ok', decision: 'cancelled' })
  })

  it('returns 404 for unknown resolved requests', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/claude-approval-resolved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ request_id: 'missing' })
    })
    expect(response.status).toBe(404)
  })

  it('cancels an approval when the hook disconnects', async () => {
    const controller = new AbortController()
    const promise = fetch(`http://127.0.0.1:${port}/claude-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        request_id: 'req_abort',
        tool_name: 'Bash',
        cwd: '/tmp/project',
        message: 'test',
        timeout_seconds: 30
      }),
      signal: controller.signal
    }).catch(() => null)
    const item = await waitFor(() => approvals[0] || null)
    controller.abort()
    await promise
    await waitFor(() => resolutions.find((entry) => entry.id === item.id) || null)
    expect(resolutions.find((entry) => entry.id === item.id)?.decision).toBe('cancelled')
  })

  it('keeps multiple approvals independent', async () => {
    const makeApproval = (requestId: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/claude-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          request_id: requestId,
          tool_name: 'Bash',
          cwd: '/tmp/project',
          message: requestId,
          timeout_seconds: 30
        })
      })
    const first = makeApproval('req_a')
    const second = makeApproval('req_b')
    await waitFor(() => (approvals.length === 2 ? approvals : null))
    const itemA = approvals.find((item) => item.requestId === 'req_a')!
    const itemB = approvals.find((item) => item.requestId === 'req_b')!
    server.respond(itemB.id, 'deny')
    server.respond(itemA.id, 'allow')
    expect(await (await first).json()).toMatchObject({ decision: 'allow' })
    expect(await (await second).json()).toMatchObject({ decision: 'deny' })
  })

  it('resolves and notifies pending approvals when the server stops', async () => {
    const promise = fetch(`http://127.0.0.1:${port}/claude-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        request_id: 'req_stop',
        session_id: 'session-stop',
        tool_name: 'Bash',
        cwd: '/tmp/project',
        message: 'stop test',
        timeout_seconds: 120
      })
    })
    const item = await waitFor(() => approvals[0] || null)
    // Graceful shutdown must not wait out the keep-alive timeout.
    const started = Date.now()
    await server.stop()
    expect(Date.now() - started).toBeLessThan(1500)
    expect(await (await promise).json()).toMatchObject({ decision: 'cancelled' })
    expect(resolutions.find((entry) => entry.id === item.id)?.decision).toBe('cancelled')
  })

  it('still resolves the hook when onResolved throws', async () => {
    const logs: string[] = []
    const seen: ApprovalItem[] = []
    const throwing = new NotifyServer(0, TOKEN, {
      onApproval: (item) => seen.push(item),
      onResolved: () => {
        throw new Error('persistence exploded')
      },
      onNotify: () => undefined,
      onLog: (_level, message) => {
        logs.push(message)
      }
    })
    await throwing.start()
    try {
      const pending = fetch(`http://127.0.0.1:${throwing.getPort()}/claude-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: approvalBody('req_resolved_throws')
      })
      const item = await waitFor(() => seen[0] || null)
      expect(throwing.respond(item.id, 'allow')).toBe(true)
      const response = await pending
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: 'ok', decision: 'allow' })
      expect(logs.some((message) => message.includes('审批完成回调异常'))).toBe(true)
    } finally {
      await throwing.stop()
    }
  })

  it('returns decision ask when onApproval throws', async () => {
    const logs: string[] = []
    const throwing = new NotifyServer(0, TOKEN, {
      onApproval: () => {
        throw new Error('ui exploded')
      },
      onResolved: () => undefined,
      onNotify: () => undefined,
      onLog: (_level, message) => {
        logs.push(message)
      }
    })
    await throwing.start()
    try {
      const response = await fetch(`http://127.0.0.1:${throwing.getPort()}/claude-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: approvalBody('req_approval_throws')
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: 'ok', decision: 'ask' })
      expect(logs.some((message) => message.includes('审批回调异常'))).toBe(true)
    } finally {
      await throwing.stop()
    }
  })

  it('returns 200 when onNotify throws', async () => {
    const logs: string[] = []
    const throwing = new NotifyServer(0, TOKEN, {
      onApproval: () => undefined,
      onResolved: () => undefined,
      onNotify: () => {
        throw new Error('notification exploded')
      },
      onLog: (_level, message) => {
        logs.push(message)
      }
    })
    await throwing.start()
    try {
      const response = await rawPost(
        throwing.getPort(),
        '/claude-notify',
        { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        JSON.stringify({ session_id: 'notify-throwing', notification_type: 'idle_prompt', message: 'x' })
      )
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' })
      expect(logs.some((message) => message.includes('通知回调异常'))).toBe(true)
    } finally {
      await throwing.stop()
    }
  })

  it('times out a half-sent body and closes the connection', async () => {
    const slow = new NotifyServer(
      0,
      TOKEN,
      {
        onApproval: () => undefined,
        onResolved: () => undefined,
        onNotify: () => undefined
      },
      { bodyTimeoutMs: 120 }
    )
    await slow.start()
    try {
      const result = await halfBodyRequest(slow.getPort(), '/claude-approval')
      expect(result.response).toContain('408')
      expect(result.response).toContain('request_timeout')
      expect(result.closed).toBe(true)
    } finally {
      await slow.stop()
    }
  })
})
