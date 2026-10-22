import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  ApprovalAnswer,
  ApprovalItem,
  ApprovalSuggestion,
  LogLevel
} from '../shared/types'
import {
  approvalFromPayload,
  buildNotification,
  safeString,
  unknownSuggestionTypes
} from './protocol'

const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 50
const MAX_TIMEOUT_SECONDS = 600
const DEDUP_SECONDS = 3

type ApprovalResult = {
  status: 'ok'
  decision: string
  index?: number
  answers?: ApprovalAnswer[]
}

interface PendingRequest {
  itemId: string
  requestId: string
  resolve: (payload: ApprovalResult) => void
  timer: NodeJS.Timeout
  finished: boolean
}

export interface ServerCallbacks {
  onApproval: (item: ApprovalItem) => void
  onResolved: (itemId: string, decision: string) => void
  onNotify: (title: string, body: string, payload: Record<string, unknown>) => void
  onLog?: (level: LogLevel, message: string) => void
}

export class NotifyServer {
  private server: Server | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notifications = new Map<string, number>()
  private listening = false
  private actualPort = 0
  private host = '0.0.0.0'

  constructor(
    public readonly port: number,
    private token: string,
    private readonly callbacks: ServerCallbacks
  ) {}

  isListening(): boolean {
    return this.listening
  }

  getPort(): number {
    return this.actualPort || this.port
  }

  setToken(token: string): void {
    this.token = token
  }

  start(host = this.host): Promise<void> {
    if (this.server) return Promise.resolve()
    this.host = host
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          console.error('[http] unhandled', error)
          sendJson(response, 500, { error: 'internal_error' })
        })
      })
      server.once('error', (error) => {
        this.server = null
        reject(error)
      })
      server.listen(this.port, this.host, () => {
        this.server = server
        this.listening = true
        const address = server.address()
        this.actualPort = typeof address === 'object' && address ? address.port : this.port
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.listening = false
    for (const pending of [...this.pending.values()]) {
      this.finish(pending, { status: 'ok', decision: 'cancelled' })
    }
    this.pending.clear()
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  respond(itemId: string, decision: string, extra?: { index?: number; answers?: ApprovalAnswer[] }): boolean {
    const pending = this.pending.get(itemId)
    if (!pending) return false
    const resolved: ApprovalResult = { status: 'ok', decision }
    if (typeof extra?.index === 'number') resolved.index = extra.index
    if (extra?.answers?.length) resolved.answers = extra.answers
    this.finish(pending, resolved)
    return true
  }

  private finish(pending: PendingRequest, result: ApprovalResult): void {
    if (pending.finished) return
    pending.finished = true
    this.pending.delete(pending.itemId)
    clearTimeout(pending.timer)
    this.callbacks.onResolved(pending.itemId, result.decision)
    pending.resolve(result)
  }

  private findByRequestId(requestId: string): PendingRequest | undefined {
    for (const pending of this.pending.values()) {
      if (pending.requestId === requestId) return pending
    }
    return undefined
  }

  private shouldNotify(payload: Record<string, unknown>): boolean {
    const session = safeString(payload.session_id) || 'unknown-session'
    const type =
      safeString(payload.notification_type) ||
      safeString(payload.matcher) ||
      'permission_prompt'
    const key = `${session}:${type}`
    const now = Date.now()
    const previous = this.notifications.get(key) || 0
    if (now - previous < DEDUP_SECONDS * 1000) return false
    this.notifications.set(key, now)
    const expiredBefore = now - 3600 * 1000
    for (const [entryKey, timestamp] of this.notifications) {
      if (timestamp < expiredBefore) this.notifications.delete(entryKey)
    }
    return true
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization || ''
    const expected = `Bearer ${this.token}`
    const receivedBuffer = Buffer.from(header)
    const expectedBuffer = Buffer.from(expected)
    if (receivedBuffer.length !== expectedBuffer.length) return false
    return timingSafeEqual(receivedBuffer, expectedBuffer)
  }

  private log(level: LogLevel, message: string): void {
    this.callbacks.onLog?.(level, message)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const path = url.pathname

    if (path === '/health' && request.method === 'GET') {
      sendJson(response, 200, {
        status: 'ok',
        service: 'claude-notify',
        port: this.getPort(),
        bind: this.host
      })
      return
    }

    if (path === '/claude-notify' && request.method === 'POST') {
      if (!this.authorized(request)) {
        this.log('warn', `认证失败：remote=${request.socket.remoteAddress || '?'}`)
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      const body = await this.readJsonBody(request, response)
      if (!body) return
      const type =
        safeString(body.notification_type) || safeString(body.matcher) || 'unknown'
      const session = safeString(body.session_id) || 'unknown'
      this.log('info', `收到通知：type=${type}, session=${session.slice(0, 16)}`)
      if (this.shouldNotify(body)) {
        const { title, body: text } = buildNotification(body)
        this.callbacks.onNotify(title, text, body)
      } else {
        this.log('info', '忽略短时间内重复通知')
      }
      sendJson(response, 200, { status: 'ok' })
      return
    }

    if (path === '/claude-approval' && request.method === 'POST') {
      if (!this.authorized(request)) {
        this.log('warn', `认证失败：remote=${request.socket.remoteAddress || '?'}`)
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      const body = await this.readJsonBody(request, response)
      if (!body) return

      const rawTimeout = Number(body.timeout_seconds)
      const timeoutSec = Number.isFinite(rawTimeout)
        ? Math.max(5, Math.min(Math.round(rawTimeout), MAX_TIMEOUT_SECONDS))
        : DEFAULT_TIMEOUT_SECONDS
      const itemId = `apr_${randomUUID()}`
      const item = approvalFromPayload(body, itemId, Date.now(), timeoutSec)

      this.log(
        'notify',
        `收到审批请求：tool=${item.tool}, kind=${item.kind}, project=${item.project}, ` +
          `suggestions=${item.suggestions.length}, timeout=${timeoutSec}s`
      )

      // AskUserQuestion 由 PreToolUse 通道负责。旧版部署或配置缺失时，
      // PermissionRequest 可能随后再来一次；这里直接回退终端，避免第二个弹窗。
      if (item.tool === 'AskUserQuestion' && item.kind === 'permission') {
        this.log(
          'warn',
          `忽略重复的 AskUserQuestion 权限请求（PreToolUse 已弹过问答）：${item.sessionLabel}`
        )
        sendJson(response, 200, { status: 'ok', decision: 'ask' })
        return
      }
      const unknown = unknownSuggestionTypes(item.suggestions)
      if (unknown.length > 0) {
        this.log('warn', `未知 suggestion 类型 ${unknown.join(', ')}，将用通用标签显示并原样回传`)
      }

      const result = new Promise<ApprovalResult>((resolve) => {
        const pending: PendingRequest = {
          itemId,
          requestId: item.requestId,
          resolve,
          finished: false,
          timer: setTimeout(() => {
            this.finish(pending, { status: 'ok', decision: 'timeout' })
          }, timeoutSec * 1000)
        }
        this.pending.set(itemId, pending)
      })

      response.on('close', () => {
        if (response.writableEnded) return
        const pending = this.pending.get(itemId)
        if (pending) this.finish(pending, { status: 'ok', decision: 'cancelled' })
      })

      this.callbacks.onApproval(item)
      const decision = await result
      const level: LogLevel =
        decision.decision === 'allow' || decision.decision === 'deny'
          ? 'notify'
          : 'warn'
      this.log(level, `审批结果：tool=${item.tool}, decision=${decision.decision}`)
      sendJson(response, 200, decision)
      return
    }

    if (path === '/claude-approval-resolved' && request.method === 'POST') {
      if (!this.authorized(request)) {
        this.log('warn', `认证失败：remote=${request.socket.remoteAddress || '?'}`)
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      const body = await this.readJsonBody(request, response)
      if (!body) return
      const requestId = safeString(body.request_id)
      if (!requestId) {
        sendJson(response, 400, { error: 'request_id_required' })
        return
      }
      const pending = this.findByRequestId(requestId)
      if (!pending) {
        sendJson(response, 404, { status: 'not_found' })
        return
      }
      if (pending.finished) {
        sendJson(response, 200, { status: 'already_finished' })
        return
      }
      this.finish(pending, { status: 'ok', decision: 'cancelled' })
      this.log('info', `终端侧已处理，弹窗同步关闭：request=${requestId.slice(0, 12)}`)
      sendJson(response, 200, { status: 'resolved' })
      return
    }

    sendJson(response, 404, { error: 'not_found' })
  }

  private async readJsonBody(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<Record<string, unknown> | null> {
    const lengthText = request.headers['content-length']
    if (lengthText === undefined) {
      sendJson(response, 411, { error: 'content_length_required' })
      return null
    }
    const length = Number(lengthText)
    if (!Number.isFinite(length)) {
      sendJson(response, 400, { error: 'invalid_content_length' })
      return null
    }
    if (length <= 0) {
      sendJson(response, 400, { error: 'empty_request_body' })
      return null
    }
    if (length > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: 'request_too_large' })
      return null
    }

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    }).catch((error) => {
      if ((error as { code?: string }).code === 'TOO_LARGE') {
        sendJson(response, 413, { error: 'request_too_large' })
      } else {
        sendJson(response, 400, { error: 'invalid_body' })
      }
      return null
    })
    if (!buffer) return null

    let raw: string
    try {
      raw = buffer.toString('utf-8')
    } catch {
      sendJson(response, 400, { error: 'body_must_be_utf8' })
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      sendJson(response, 400, { error: 'invalid_json' })
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(response, 400, { error: 'json_root_must_be_object' })
      return null
    }
    return parsed as Record<string, unknown>
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  response.end(payload)
}
