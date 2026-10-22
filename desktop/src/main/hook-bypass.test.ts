import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const python = process.platform === 'win32' ? 'python' : 'python3'
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0
const hookPath = join(process.cwd(), 'resources', 'hooks', 'claude_approval_hook.py')
const maybe = hasPython ? it : it.skip

interface HookRun {
  code: number | null
  stdout: string
  stderr: string
  requests: number
}

async function runHook(permissionMode: string): Promise<HookRun> {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-notify-hook-'))
  const transcript = join(dataDir, 'transcript.jsonl')
  writeFileSync(transcript, '')
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', decision: 'allow' }))
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
        CLAUDE_APPROVAL_URL: `http://127.0.0.1:${port}/claude-approval`,
        CLAUDE_APPROVAL_TIMEOUT: '2',
        CLAUDE_NOTIFY_DATA_DIR: dataDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        permission_mode: permissionMode,
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
        session_id: 'hook-test-session',
        cwd: dataDir,
        transcript_path: transcript
      })
    )
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve(null)
      }, 8000)
      child.on('exit', (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    return { code, stdout, stderr, requests }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe('approval hook bypass guard', () => {
  maybe('does not contact the desktop in bypass-like modes', async () => {
    for (const mode of ['bypassPermissions', 'bypass', 'dontAsk']) {
      const result = await runHook(mode)
      expect(result.code, `${mode}: ${result.stderr}`).toBe(0)
      expect(result.requests, `${mode} should not request approval`).toBe(0)
      expect(result.stdout.trim(), `${mode} should not emit a decision`).toBe('')
    }
  })

  maybe('still requests approval in default mode', async () => {
    const result = await runHook('default')
    expect(result.code, result.stderr).toBe(0)
    expect(result.requests).toBe(1)
    expect(result.stdout).toContain('allow')
  })
})
