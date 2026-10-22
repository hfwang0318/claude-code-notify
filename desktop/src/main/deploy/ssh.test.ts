import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEPLOY_CANCELLED,
  SSH_COMMAND_TIMEOUT,
  execCommand,
  humanizeSshError,
  isDeployCancelled
} from './ssh'

class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter()
  closed = false

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', 0)
  }
}

function fakeClient(stream: FakeStream): Client {
  return {
    exec: (
      _command: string,
      callback: (error: Error | undefined, channel: ClientChannel) => void
    ): void => {
      callback(undefined, stream as unknown as ClientChannel)
    }
  } as unknown as Client
}

afterEach(() => {
  vi.useRealTimers()
})

describe('execCommand', () => {
  it('resolves with the exit code and captured output', async () => {
    const stream = new FakeStream()
    const promise = execCommand(fakeClient(stream), 'echo hi', 1000)
    stream.emit('data', Buffer.from('hi\n'))
    stream.stderr.emit('data', Buffer.from('warn'))
    stream.emit('close', 7)
    await expect(promise).resolves.toEqual({ code: 7, stdout: 'hi\n', stderr: 'warn' })
  })

  it('rejects with SSH_COMMAND_TIMEOUT and closes the stream after the deadline', async () => {
    vi.useFakeTimers()
    const stream = new FakeStream()
    const promise = execCommand(fakeClient(stream), 'sleep 60', 100)
    const rejection = expect(promise).rejects.toMatchObject({ code: SSH_COMMAND_TIMEOUT })
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(stream.closed).toBe(true)
    expect(humanizeSshError(await promise.catch((error: unknown) => error))).toContain(
      'SSH 命令执行超时'
    )
  })

  it('settles once even if close and error arrive after a timeout', async () => {
    vi.useFakeTimers()
    const stream = new FakeStream()
    const promise = execCommand(fakeClient(stream), 'sleep 60', 50)
    const rejection = expect(promise).rejects.toMatchObject({ code: SSH_COMMAND_TIMEOUT })
    await vi.advanceTimersByTimeAsync(50)
    await rejection
    expect(() => stream.emit('close', 0)).not.toThrow()
    expect(() => stream.emit('error', new Error('late failure'))).not.toThrow()
    await expect(promise).rejects.toMatchObject({ code: SSH_COMMAND_TIMEOUT })
  })

  it('rejects with DEPLOY_CANCELLED when the abort signal fires', async () => {
    const controller = new AbortController()
    const stream = new FakeStream()
    const promise = execCommand(fakeClient(stream), 'sleep 60', 60000, controller.signal)
    const rejection = expect(promise).rejects.toMatchObject({ code: DEPLOY_CANCELLED })
    controller.abort()
    await rejection
    expect(stream.closed).toBe(true)
  })
})

describe('humanizeSshError', () => {
  it('explains command timeouts', () => {
    const error = Object.assign(new Error('timeout'), { code: SSH_COMMAND_TIMEOUT })
    expect(humanizeSshError(error)).toBe('SSH 命令执行超时，请检查网络或服务器负载')
  })

  it('reports cancellation while preserving the typed error code', () => {
    const error = Object.assign(new Error('aborted'), { code: DEPLOY_CANCELLED })
    expect(humanizeSshError(error)).toBe('部署已取消')
    expect(isDeployCancelled(error)).toBe(true)
    expect(isDeployCancelled(new Error('other'))).toBe(false)
  })
})
