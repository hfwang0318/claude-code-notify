import { request } from 'node:http'
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
    await server.stop()
    expect(await (await promise).json()).toMatchObject({ decision: 'cancelled' })
    expect(resolutions.find((entry) => entry.id === item.id)?.decision).toBe('cancelled')
  })
})
