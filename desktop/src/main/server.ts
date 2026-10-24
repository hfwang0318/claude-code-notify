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
const REQUEST_TIMEOUT_MS = 15_000
const HEADERS_TIMEOUT_MS = 10_000
const BODY_TIMEOUT_MS = 15_000
const MAX_CONNECTIONS = 128

export interface NotifyServerOptions {
  /** Maximum time to wait for the full HTTP body. Defaults to 15s. */
  bodyTimeoutMs?: number
  requestTimeoutMs?: number
  headersTimeoutMs?: number
  maxConnections?: number
}

type ApprovalResult = {
  status: 'ok'
  decision: string
  index?: number
  answers?: ApprovalAnswer[]
  reason?: string
}

interface PendingRequest {
  itemId: string
  requestId: string
  resolve: (payload: ApprovalResult) => void
  timer: NodeJS.Timeout
  finished: boolean
  timeoutAt: number
  paused: boolean
  remainingMs: number
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
  private readonly options: Required<NotifyServerOptions>
  private listening = false
  private actualPort = 0
  private host = '0.0.0.0'

  constructor(
    public readonly port: number,
    private token: string,
    private readonly callbacks: ServerCallbacks,
    options: NotifyServerOptions = {}
  ) {
    this.options = {
      bodyTimeoutMs: options.bodyTimeoutMs ?? BODY_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      headersTimeoutMs: options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      maxConnections: options.maxConnections ?? MAX_CONNECTIONS
    }
  }

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
      // Bound every stage of a request so a slow or half-open client cannot pin
      // a socket (or the whole connection pool) forever.
      server.requestTimeout = this.options.requestTimeoutMs
      server.headersTimeout = this.options.headersTimeoutMs
      server.maxConnections = this.options.maxConnections
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
    return new Promise((resolve) => {
      let settled = false
      let idleTimer: NodeJS.Timeout | null = null
      let forceTimer: NodeJS.Timeout | null = null
      const done = (): void => {
        if (settled) return
        settled = true
        if (idleTimer) clearTimeout(idleTimer)
        if (forceTimer) clearTimeout(forceTimer)
        resolve()
      }
      server.close(done)
      // Pending approvals are resolved just before close(), so their responses
      // are flushed on the next tick. Reap those sockets once idle instead of
      // waiting for the keep-alive timeout (otherwise quit stalls ~4s).
      idleTimer = setTimeout(() => server.closeIdleConnections(), 100)
      idleTimer.unref?.()
      // Never let a stuck/half-open request hold shutdown hostage.
      forceTimer = setTimeout(() => {
        server.closeAllConnections()
        done()
      }, 2000)
      forceTimer.unref?.()
    })
  }

  respond(
    itemId: string,
    decision: string,
    extra?: { index?: number; answers?: ApprovalAnswer[]; reason?: string }
  ): boolean {
    const pending = this.pending.get(itemId)
    if (!pending) return false
    const resolved: ApprovalResult = { status: 'ok', decision }
    if (typeof extra?.index === 'number') resolved.index = extra.index
    if (extra?.answers?.length) resolved.answers = extra.answers
    if (typeof extra?.reason === 'string' && extra.reason.trim()) {
      resolved.reason = extra.reason.trim().slice(0, 2000)
    }
    this.finish(pending, resolved)
    return true
  }

  /**
   * Freeze a pending approval's timeout. The hook socket stays open; the user
   * can type a long answer without racing the original countdown.
   */
  pause(itemId: string): { remainingMs: number } | null {
    const pending = this.pending.get(itemId)
    if (!pending || pending.finished || pending.paused) return null
    const remainingMs = Math.max(0, pending.timeoutAt - Date.now())
    pending.paused = true
    pending.remainingMs = remainingMs
    clearTimeout(pending.timer)
    return { remainingMs }
  }

  /** Resume a paused approval from the exact remaining time (or an override). */
  resume(itemId: string, remainingMs?: number): { timeoutAt: number } | null {
    const pending = this.pending.get(itemId)
    if (!pending || pending.finished || !pending.paused) return null
    const wait = Math.max(0, remainingMs ?? pending.remainingMs)
    pending.paused = false
    pending.remainingMs = wait
    pending.timeoutAt = Date.now() + wait
    pending.timer = setTimeout(() => {
      this.finish(pending, { status: 'ok', decision: 'timeout' })
    }, wait)
    pending.timer.unref?.()
    return { timeoutAt: pending.timeoutAt }
  }

  private finish(pending: PendingRequest, result: ApprovalResult): void {
    if (pending.finished) return
    pending.finished = true
    this.pending.delete(pending.itemId)
    clearTimeout(pending.timer)
    // UI/persistence callbacks must never block the HTTP response: a throwing
    // onResolved used to leave the hook waiting until its own timeout.
    try {
      this.callbacks.onResolved(pending.itemId, result.decision)
    } catch (error) {
      this.log('error', `审批完成回调异常（已忽略）：${errorText(error)}`)
    }
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
    try {
      this.callbacks.onLog?.(level, message)
    } catch {
      // logging must never break request handling
    }
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
        try {
          this.callbacks.onNotify(title, text, body)
        } catch (error) {
          // Notification delivery is best-effort; the hook still needs its 200.
          this.log('error', `通知回调异常（已忽略）：${errorText(error)}`)
        }
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

      let resolvePending!: (payload: ApprovalResult) => void
      const result = new Promise<ApprovalResult>((resolve) => {
        resolvePending = resolve
      })
      const deadline = Date.now() + timeoutSec * 1000
      const pending: PendingRequest = {
        itemId,
        requestId: item.requestId,
        resolve: resolvePending,
        finished: false,
        timeoutAt: deadline,
        paused: false,
        remainingMs: timeoutSec * 1000,
        timer: setTimeout(() => {
          this.finish(pending, { status: 'ok', decision: 'timeout' })
        }, timeoutSec * 1000)
      }
      this.pending.set(itemId, pending)

      response.on('close', () => {
        if (response.writableEnded) return
        const active = this.pending.get(itemId)
        if (active) this.finish(active, { status: 'ok', decision: 'cancelled' })
      })

      try {
        this.callbacks.onApproval(item)
      } catch (error) {
        // A broken UI/persistence layer must not strand the hook: fall back to
        // the terminal with the same decision the popup uses for "ask".
        this.log('error', `审批回调异常，回退终端：${errorText(error)}`)
        this.finish(pending, { status: 'ok', decision: 'ask' })
      }
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
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        request.off('data', onData)
        request.off('end', onEnd)
        request.off('error', onError)
        request.off('aborted', onAborted)
      }
      const fail = (error: Error & { code?: string }): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onData = (chunk: Buffer): void => {
        if (settled) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          fail(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }))
          return
        }
        chunks.push(chunk)
      }
      const onEnd = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(Buffer.concat(chunks))
      }
      const onError = (error: Error): void => fail(error)
      const onAborted = (): void =>
        fail(Object.assign(new Error('request aborted'), { code: 'ABORTED' }))

      // A client that sends headers plus a partial body must not hold a socket
      // forever. The timer is the only place that settles on inactivity.
      timer = setTimeout(() => {
        fail(Object.assign(new Error('body timeout'), { code: 'BODY_TIMEOUT' }))
      }, this.options.bodyTimeoutMs)
      timer.unref?.()

      request.on('data', onData)
      request.on('end', onEnd)
      request.on('error', onError)
      request.on('aborted', onAborted)
    }).catch((error) => {
      const code = (error as { code?: string }).code
      if (code === 'TOO_LARGE') {
        sendJson(response, 413, { error: 'request_too_large' }, { Connection: 'close' })
        closeAfterResponse(request, response)
      } else if (code === 'BODY_TIMEOUT') {
        this.log(
          'warn',
          `请求体读取超时（${this.options.bodyTimeoutMs}ms），关闭连接：remote=${request.socket.remoteAddress || '?'}`
        )
        sendJson(response, 408, { error: 'request_timeout' }, { Connection: 'close' })
        closeAfterResponse(request, response)
      } else if (code === 'ABORTED') {
        // The client is gone; there is no one to answer.
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function closeAfterResponse(request: IncomingMessage, response: ServerResponse): void {
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    request.destroy()
  }
  response.once('finish', close)
  response.once('close', close)
  // Fallback for a wedged socket; unref so it never keeps the process alive.
  const timer = setTimeout(close, 5000)
  timer.unref?.()
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  if (response.writableEnded || response.destroyed) return
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders
  })
  response.end(payload)
}
