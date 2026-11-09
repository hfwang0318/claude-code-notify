import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const python = process.platform === 'win32' ? 'python' : 'python3'
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0
const hookPath = join(process.cwd(), 'resources', 'hooks', 'claude_notify_hook.py')
const maybe = hasPython ? it : it.skip

describe('notify hook loopback transport', () => {
  maybe(
    'delivers notifications despite environment proxy variables',
    async () => {
      let requests = 0
      const server = createServer((request, response) => {
        requests += 1
        request.resume()
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ status: 'ok' }))
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      try {
        const child = spawn(python, [hookPath], {
          env: {
            ...process.env,
            CLAUDE_NOTIFY_TOKEN: 'test-token',
            CLAUDE_NOTIFY_URL: `http://127.0.0.1:${port}/claude-notify`,
            HTTP_PROXY: 'http://127.0.0.1:1',
            HTTPS_PROXY: 'http://127.0.0.1:1',
            http_proxy: 'http://127.0.0.1:1',
            https_proxy: 'http://127.0.0.1:1',
            NO_PROXY: '',
            no_proxy: ''
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.stdin.end(
          JSON.stringify({
            session_id: 'notify-proxy',
            cwd: '/tmp',
            notification_type: 'idle_prompt'
          })
        )
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGTERM')
            resolve(null)
          }, 15000)
          child.on('exit', (value) => {
            clearTimeout(timer)
            resolve(value)
          })
        })
        expect(code, stderr).toBe(0)
        expect(requests, stderr).toBe(1)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    20000
  )
})
