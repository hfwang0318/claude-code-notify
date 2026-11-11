import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'resources', 'hooks', 'claude_tab_status_hook.py')
const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001'

function findPython(): { command: string; args: string[] } | null {
  const candidates =
    process.platform === 'win32'
      ? [
          ['py', '-3'],
          ['python'],
          ['python3']
        ]
      : [
          ['python3'],
          ['python']
        ]
  for (const [command, ...args] of candidates) {
    const probe = spawnSync(command, [...args, '--version'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true
    })
    if (probe.status === 0) return { command, args }
  }
  return null
}

const python = findPython()
let stateDir = ''
let statePath = ''
let transcriptPath = ''
let tabConfigPath = ''

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'claude-notify-tab-state-'))
  statePath = join(stateDir, 'state.json')
  transcriptPath = join(stateDir, 'transcript.jsonl')
  tabConfigPath = join(stateDir, 'claude_notify_config.json')
})

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  stateDir = ''
  statePath = ''
  transcriptPath = ''
  tabConfigPath = ''
})

function writeTabConfig(
  prefix: string[],
  suffix: string[],
  origin = ''
): void {
  writeFileSync(
    tabConfigPath,
    JSON.stringify({
      CLAUDE_NOTIFY_TAB_PREFIX: JSON.stringify(prefix),
      CLAUDE_NOTIFY_TAB_SUFFIX: JSON.stringify(suffix),
      CLAUDE_NOTIFY_ORIGIN: origin
    })
  )
}

function writeAiTitles(...titles: string[]): void {
  writeFileSync(
    transcriptPath,
    `${titles.map((title) => JSON.stringify({ type: 'ai-title', aiTitle: title })).join('\n')}\n`
  )
}

function run(
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {}
): Record<string, unknown> {
  if (!python) throw new Error('python is unavailable')
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_NOTIFY_TAB_STATE: statePath,
    CLAUDE_NOTIFY_TAB_CONFIG: tabConfigPath,
    CLAUDE_NOTIFY_TITLE_DISABLE: '1',
    ...extraEnv
  }
  if (!('CLAUDE_CODE_DISABLE_TERMINAL_TITLE' in extraEnv)) {
    delete env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE
  }
  const result = spawnSync(python.command, [...python.args, script], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true,
    env
  })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function event(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return run({
    hook_event_name: name,
    session_id: SESSION_ID,
    cwd: '/tmp/demo',
    ...extra
  })
}

function title(dot: string, label: string): string {
  return `\x1b]0;${dot} ${label}\x07\x1b]1;${dot} ${label}\x07\x1b]2;${dot} ${label}\x07`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function transcriptLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`
}

function appendTranscriptLine(entry: Record<string, unknown>): void {
  writeFileSync(transcriptPath, transcriptLine(entry), { flag: 'a' })
}

function startInterruptWatcher(turnStartedAt = '0'): {
  wait: () => Promise<number | null>
  output: () => string
} {
  if (!python) throw new Error('python is unavailable')
  const ttyPath = join(stateDir, 'tty.txt')
  writeFileSync(ttyPath, '')
  const ttyFd = openSync(ttyPath, 'w')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_NOTIFY_TAB_STATE: statePath,
    CLAUDE_NOTIFY_TAB_CONFIG: tabConfigPath,
    CLAUDE_NOTIFY_TITLE_DISABLE: '1'
  }
  delete env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE
  // Node has no pass_fds; hand the tty over as the fourth stdio entry, which
  // the child sees as fd 3.
  const child = spawn(
    python.command,
    [
      ...python.args,
      script,
      '--watch-interrupt',
      '3',
      SESSION_ID,
      transcriptPath,
      '/tmp/demo',
      String(process.pid),
      turnStartedAt
    ],
    { env, stdio: ['ignore', 'ignore', 'ignore', ttyFd], windowsHide: true }
  )
  closeSync(ttyFd)
  return {
    wait: () =>
      new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('interrupt watcher did not exit in time'))
        }, 10000)
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve(code)
        })
      }),
    output: () => readFileSync(ttyPath, 'utf-8')
  }
}

function titleWorkerEnv(
  baseUrl: string,
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_NOTIFY_TAB_STATE: statePath,
    CLAUDE_NOTIFY_TAB_CONFIG: tabConfigPath,
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    ANTHROPIC_MODEL: 'test-model',
    ANTHROPIC_BASE_URL: baseUrl,
    // Inherited proxy settings must not leak into these cases.
    http_proxy: undefined,
    HTTP_PROXY: undefined,
    https_proxy: undefined,
    HTTPS_PROXY: undefined,
    all_proxy: undefined,
    ALL_PROXY: undefined,
    no_proxy: undefined,
    NO_PROXY: undefined,
    ...extra
  }
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function writeTitleState(firstPrompt: string): void {
  writeFileSync(
    statePath,
    JSON.stringify({
      [SESSION_ID]: {
        first_prompt: firstPrompt,
        title_attempted: 1,
        ts: Date.now() / 1000
      }
    })
  )
}

function generatedTitle(): string | undefined {
  const state = JSON.parse(readFileSync(statePath, 'utf-8'))
  return state[SESSION_ID]?.generated_title
}

async function runTitleWorker(env: NodeJS.ProcessEnv): Promise<void> {
  if (!python) throw new Error('python is unavailable')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      python.command,
      [...python.args, script, '--generate-title', SESSION_ID],
      { env, stdio: 'ignore', windowsHide: true }
    )
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('title worker did not exit in time'))
    }, 40000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function startTitleServer(
  delayMs: number
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            content: [
              { type: 'text', text: JSON.stringify({ title: '慢路由标题' }) }
            ]
          })
        )
      }, delayMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('title server did not bind a port')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

describe.skipIf(!python)('claude_tab_status_hook.py', () => {
  it('falls back to project + short id when no task is known', () => {
    const output = event('SessionStart')
    expect(output.terminalSequence).toBe(title('🟢', 'demo #a1b2'))
  })

  it('prefers the official custom session title over AI title and task', () => {
    writeAiTitles('AI 会话标题')
    let output = event('UserPromptSubmit', {
      prompt: '修复登录超时',
      session_title: '自定义会话',
      transcript_path: transcriptPath
    })
    expect(output.terminalSequence).toBe(title('🟡', '自定义会话'))

    output = event('Stop', { transcript_path: transcriptPath })
    expect(output.terminalSequence).toBe(title('🟢', '自定义会话'))
  })

  it('prefers the latest AI title over the prompt task', () => {
    writeAiTitles('旧标题', 'Claude Code 终端标签页状态指示')
    const output = event('UserPromptSubmit', {
      prompt: '修复登录超时',
      transcript_path: transcriptPath
    })
    expect(output.terminalSequence).toBe(title('🟡', 'Claude Code 终端标签页状态指示'))
  })

  it('ignores stale AI titles when the built-in title is disabled', () => {
    writeAiTitles('AI 会话标题')
    const output = run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: '修复登录超时',
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    expect(output.terminalSequence).toBe(title('🟡', '修复登录超时'))
  })

  it('uses the generated session title when the official AI title is disabled', () => {
    writeAiTitles('stale AI title')
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: {
          first_prompt: '修复登录超时',
          generated_title: '登录超时修复',
          generated_for: '修复登录超时',
          ts: Date.now() / 1000
        }
      })
    )
    const output = run(
      {
        hook_event_name: 'Stop',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    expect(output.terminalSequence).toBe(title('🟢', '登录超时修复'))
  })

  it('ignores a generated title made for a different first prompt', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: {
          task: '修复登录超时',
          first_prompt: '修复登录超时',
          generated_title: '旧标题',
          generated_for: '另一个任务',
          ts: Date.now() / 1000
        }
      })
    )
    const output = run(
      {
        hook_event_name: 'Stop',
        session_id: SESSION_ID,
        cwd: '/tmp/demo'
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    expect(output.terminalSequence).toBe(title('🟢', '修复登录超时'))
  })

  it('embeds the official generateSessionTitle prompt and input contract', () => {
    const text = readFileSync(script, 'utf-8')
    expect(text).toContain(
      'You are naming a coding session so the user can pick it out of a long list of sessions.'
    )
    expect(text).toContain('Return JSON with a single "title" field.')
    expect(text).toContain(
      'Write the title in the predominant language of the session'
    )
    expect(text).toContain('first_prompt')
    expect(text).toContain('title_attempted')
  })

  it('stores the first prompt once and cools down repeated title attempts', () => {
    const firstPrompt = '实现终端 tab 的状态指示，用黄绿红表示运行/完成/阻塞'
    run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: firstPrompt,
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    let state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state[SESSION_ID].first_prompt).toBe(firstPrompt)
    expect(state[SESSION_ID].title_attempted).toBe(1)
    const attemptedAt = state[SESSION_ID].title_attempted_at
    expect(attemptedAt).toBeGreaterThan(0)

    run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: '另一个任务',
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state[SESSION_ID].first_prompt).toBe(firstPrompt)
    expect(state[SESSION_ID].task).toBe('另一个任务')
    // The first worker may still be in flight; do not stack another request.
    expect(state[SESSION_ID].title_attempted_at).toBe(attemptedAt)
  })

  it('retries title generation on a later prompt when the first attempt failed', () => {
    const firstPrompt = '实现终端 tab 的状态指示，用黄绿红表示运行/完成/阻塞'
    run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: firstPrompt,
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    const attemptedAt = state[SESSION_ID].title_attempted_at

    // Pretend the first worker failed long enough ago for the cooldown to
    // expire; a fresh prompt must schedule another attempt.
    state[SESSION_ID].title_attempted_at = attemptedAt - 600
    delete state[SESSION_ID].generated_title
    writeFileSync(statePath, JSON.stringify(state))

    run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: '再帮我看一下另一个模块',
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    const next = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(next[SESSION_ID].first_prompt).toBe(firstPrompt)
    expect(next[SESSION_ID].title_attempted_at).toBeGreaterThan(
      attemptedAt - 600
    )
  })

  it('does not retry after a title already exists', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: {
          first_prompt: '实现终端 tab 的状态指示，用黄绿红表示运行/完成/阻塞',
          generated_title: '终端 tab 状态指示',
          generated_for: '实现终端 tab 的状态指示，用黄绿红表示运行/完成/阻塞',
          title_attempted: 1,
          title_attempted_at: 1,
          ts: Date.now() / 1000
        }
      })
    )
    run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: '再帮我看一下另一个模块',
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state[SESSION_ID].title_attempted_at).toBe(1)
  })

  it('lets a later prompt replace a too-short first prompt', () => {
    run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: 'hi',
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    let state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state[SESSION_ID].first_prompt).toBe('hi')

    run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: '修复登录超时并补充回归测试',
        transcript_path: transcriptPath
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state[SESSION_ID].first_prompt).toBe('修复登录超时并补充回归测试')
  })

  it('classifies loopback targets but not public endpoints', () => {
    const probe = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("tab_hook", ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps([
  module._is_loopback_url("http://127.0.0.1:3456/v1/messages"),
  module._is_loopback_url("http://localhost:18765/claude-notify"),
  module._is_loopback_url("http://[::1]:3456/v1/messages"),
  module._is_loopback_url("https://api.anthropic.com/v1/messages"),
]))
`
    const result = spawnSync(python!.command, [...python!.args, '-c', probe], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual([true, true, true, false])
  })

  it('uses the AI title even before the first task is known', () => {
    writeAiTitles('Claude Code 终端标签页状态指示')
    const output = event('SessionStart', { transcript_path: transcriptPath })
    expect(output.terminalSequence).toBe(title('🟢', 'Claude Code 终端标签页状态指示'))
  })

  it('does not truncate long official AI titles', () => {
    const longTitle = 'Qwen-Image-2.1-Uncensored-GGUF 版本选择'
    writeAiTitles(longTitle)
    const output = event('SessionStart', { transcript_path: transcriptPath })
    expect(output.terminalSequence).toBe(title('🟢', longTitle))
  })

  it('clears a custom title when the session no longer reports one', () => {
    writeAiTitles('AI 会话标题')
    event('UserPromptSubmit', {
      prompt: '修复登录超时',
      session_title: '自定义会话',
      transcript_path: transcriptPath
    })
    const output = event('UserPromptSubmit', {
      prompt: '继续',
      transcript_path: transcriptPath
    })
    expect(output.terminalSequence).toBe(title('🟡', 'AI 会话标题'))
  })

  it('appends blocking detail to the AI title', () => {
    writeAiTitles('Claude Code 终端标签页状态指示')
    event('UserPromptSubmit', {
      prompt: '修复登录超时',
      transcript_path: transcriptPath
    })
    const output = event('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      transcript_path: transcriptPath
    })
    expect(output.terminalSequence).toBe(
      title('🔴', 'Claude Code 终端标签页状态指示 · Bash: npm install')
    )
  })

  it('uses the configured prefix/suffix items in order', () => {
    mkdirSync(join(stateDir, '.git'), { recursive: true })
    writeFileSync(join(stateDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeTabConfig(['project', 'branch'], ['shortId'])
    const project = basename(stateDir)
    const output = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      cwd: stateDir,
      prompt: '修复登录超时'
    })
    expect(output.terminalSequence).toBe(
      title('🟡', `${project} · main · 修复登录超时 · #a1b2`)
    )
  })

  it('honours an explicitly empty prefix', () => {
    writeTabConfig([], [])
    const output = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      cwd: '/tmp/demo',
      prompt: '修复登录超时'
    })
    expect(output.terminalSequence).toBe(title('🟡', '修复登录超时'))
  })

  it('supports origin and terminal items', () => {
    writeTabConfig(['origin'], ['terminal'], 'docker')
    const output = run(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        prompt: '修复登录超时'
      },
      { TERM_PROGRAM: 'TestTerm' }
    )
    expect(output.terminalSequence).toBe(
      title('🟡', 'docker · 修复登录超时 · TestTerm')
    )
  })

  it('does not duplicate the current task when it is also a suffix item', () => {
    writeTabConfig(['project'], ['task'])
    const output = run({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      cwd: '/tmp/demo',
      prompt: '修复登录超时'
    })
    expect(output.terminalSequence).toBe(title('🟡', 'demo · 修复登录超时'))
  })

  it('uses the current task for running and completed states', () => {
    let output = event('UserPromptSubmit', { prompt: '修复登录超时' })
    expect(output.terminalSequence).toBe(title('🟡', '修复登录超时'))

    output = event('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' }
    })
    expect(output.terminalSequence).toBe(title('🟡', '修复登录超时'))

    output = event('PostToolUse')
    expect(output.terminalSequence).toBe(title('🟡', '修复登录超时'))

    output = event('Stop')
    expect(output.terminalSequence).toBe(title('🟢', '修复登录超时'))
  })

  it('appends the blocking Bash command in red', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    const output = event('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' }
    })
    expect(output.terminalSequence).toBe(
      title('🔴', '修复登录超时 · Bash: npm install')
    )
  })

  it('appends the edited file in red', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    const output = event('PermissionRequest', {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts' }
    })
    expect(output.terminalSequence).toBe(title('🔴', '修复登录超时 · 编辑 auth.ts'))
  })

  it('appends the first question for AskUserQuestion', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    const output = event('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '部署到哪个环境' }] }
    })
    expect(output.terminalSequence).toBe(
      title('🔴', '修复登录超时 · 回答：部署到哪个环境')
    )
  })

  it('appends the plan confirmation for ExitPlanMode', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    const output = event('PreToolUse', { tool_name: 'ExitPlanMode' })
    expect(output.terminalSequence).toBe(
      title('🔴', '修复登录超时 · 确认计划')
    )
  })

  it('keeps the task for a pure confirmation prompt', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    const output = event('UserPromptSubmit', { prompt: '继续' })
    expect(output.terminalSequence).toBe(title('🟡', '修复登录超时'))
  })

  it('maps blocking and ready notifications', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })

    let output = event('Notification', { notification_type: 'permission_prompt' })
    expect(output.terminalSequence).toBe(title('🔴', '修复登录超时'))

    output = event('Notification', { notification_type: 'idle_prompt' })
    expect(output.terminalSequence).toBe(title('🟢', '修复登录超时'))
  })

  it('leaves the title alone for unknown notification types', () => {
    const output = event('Notification', { notification_type: 'something_else' })
    expect(output.terminalSequence).toBeUndefined()
  })

  it('clears the session task on SessionEnd', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    let output = event('SessionEnd')
    expect(output.terminalSequence).toBe(title('🟢', '修复登录超时'))

    output = event('SessionStart')
    expect(output.terminalSequence).toBe(title('🟢', 'demo #a1b2'))
  })

  it('keeps the generated title across SessionEnd so resume shows it', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: {
          first_prompt: '修复登录超时并补充回归测试',
          generated_title: '登录超时修复',
          generated_for: '修复登录超时并补充回归测试',
          ts: Date.now() / 1000
        }
      })
    )
    let output = run(
      {
        hook_event_name: 'SessionEnd',
        session_id: SESSION_ID,
        cwd: '/tmp/demo'
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    expect(output.terminalSequence).toBe(title('🟢', '登录超时修复'))

    output = run(
      {
        hook_event_name: 'SessionStart',
        session_id: SESSION_ID,
        cwd: '/tmp/demo',
        source: 'resume'
      },
      { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    )
    expect(output.terminalSequence).toBe(title('🟢', '登录超时修复'))
  })

  it('resets the task when SessionStart reports source=clear', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    let output = event('SessionStart', { source: 'clear' })
    expect(output.terminalSequence).toBe(title('🟢', 'demo #a1b2'))

    output = event('Stop')
    expect(output.terminalSequence).toBe(title('🟢', 'demo #a1b2'))
  })

  it('keeps the task when SessionStart reports source=resume', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    const output = event('SessionStart', { source: 'resume' })
    expect(output.terminalSequence).toBe(title('🟢', '修复登录超时'))
  })

  it('keeps the running dot when auto-compaction reports source=compact', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    const output = event('SessionStart', { source: 'compact' })
    expect(output.terminalSequence).toBe(title('🟡', '修复登录超时'))
  })

  it('keeps the ready dot when compaction happens between turns', () => {
    event('UserPromptSubmit', { prompt: '修复登录超时' })
    event('Stop')
    const output = event('SessionStart', { source: 'compact' })
    expect(output.terminalSequence).toBe(title('🟢', '修复登录超时'))
  })

  it('assumes a running turn when compaction has no previous state', () => {
    const output = event('SessionStart', { source: 'compact' })
    expect(output.terminalSequence).toBe(title('🟡', 'demo #a1b2'))
  })

  it('truncates a long task to the configured limit', () => {
    const prompt = 'a'.repeat(60)
    const output = event('UserPromptSubmit', { prompt })
    expect(output.terminalSequence).toBe(title('🟡', 'a'.repeat(60)))
  })

  it('strips control characters from the task', () => {
    const output = event('UserPromptSubmit', {
      prompt: '修复\x1b]2;bad\x07登录'
    })
    expect(output.terminalSequence).toBe(title('🟡', '修复 ]2;bad 登录'))
  })

  it('falls back without a short id when session_id is missing', () => {
    const output = run({ hook_event_name: 'SessionStart', cwd: '/tmp/demo' })
    expect(output.terminalSequence).toBe(title('🟢', 'demo'))
  })

  it('waits past 8s for a slow structured title request', async () => {
    const firstPrompt = '/gc-req-clarify 分析需求：maau net name 优化 maau net name'
    writeTitleState(firstPrompt)
    const server = await startTitleServer(9000)
    try {
      await runTitleWorker(titleWorkerEnv(server.url))
    } finally {
      await server.close()
    }
    expect(generatedTitle()).toBe('慢路由标题')
  }, 30000)

  it('reaches a loopback model router even when HTTP(S)_PROXY is set', async () => {
    const firstPrompt = '修复登录超时并补充回归测试，避免标题请求失败'
    writeTitleState(firstPrompt)
    const server = await startTitleServer(0)
    const proxy = 'http://127.0.0.1:1'
    try {
      await runTitleWorker(
        titleWorkerEnv(server.url, {
          http_proxy: proxy,
          HTTP_PROXY: proxy,
          https_proxy: proxy,
          HTTPS_PROXY: proxy
        })
      )
    } finally {
      await server.close()
    }
    expect(generatedTitle()).toBe('慢路由标题')
  }, 30000)

  it('turns the tab green when the transcript records a user interrupt', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '修复登录超时' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: { task: '修复登录超时', ts: Date.now() / 1000 }
      })
    )
    const watcher = startInterruptWatcher()
    await delay(600)
    appendTranscriptLine({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'working' }],
        stop_reason: null
      }
    })
    appendTranscriptLine({
      type: 'user',
      message: { content: '[Request interrupted by user]' }
    })
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe(title('🟢', '修复登录超时'))
  }, 15000)

  it('turns the tab green when an in-flight tool is interrupted', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '运行 sleep 60' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: { task: '运行 sleep 60', ts: Date.now() / 1000 }
      })
    )
    const watcher = startInterruptWatcher()
    await delay(600)
    appendTranscriptLine({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        stop_reason: 'tool_use'
      }
    })
    appendTranscriptLine({
      type: 'user',
      message: { content: '[Request interrupted by user for tool use]' }
    })
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe(title('🟢', '运行 sleep 60'))
  }, 15000)

  it('exits without writing when the turn ends normally', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '修复登录超时' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: { task: '修复登录超时', ts: Date.now() / 1000 }
      })
    )
    const watcher = startInterruptWatcher()
    await delay(600)
    appendTranscriptLine({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn'
      }
    })
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe('')
  }, 15000)

  it('catches a marker written right after an assistant stop_sequence', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '修复登录超时' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: { task: '修复登录超时', ts: Date.now() / 1000 }
      })
    )
    const watcher = startInterruptWatcher()
    await delay(600)
    // Real transcripts write the marker 8-13ms after stop_sequence; both
    // lines can land in the same poll batch.
    writeFileSync(
      transcriptPath,
      `${transcriptLine({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partial' }],
          stop_reason: 'stop_sequence'
        }
      })}${transcriptLine({
        type: 'user',
        message: { content: '[Request interrupted by user]' }
      })}`,
      { flag: 'a' }
    )
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe(title('🟢', '修复登录超时'))
  }, 15000)

  it('does not turn green when a newer prompt follows the marker', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '修复登录超时' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: { task: '修复登录超时', ts: Date.now() / 1000 }
      })
    )
    const watcher = startInterruptWatcher()
    await delay(600)
    writeFileSync(
      transcriptPath,
      `${transcriptLine({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partial' }],
          stop_reason: null
        }
      })}${transcriptLine({
        type: 'user',
        message: { content: '[Request interrupted by user]' }
      })}${transcriptLine({
        type: 'user',
        message: { content: '先不要跑 e2e，先看这个故事' }
      })}`,
      { flag: 'a' }
    )
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe('')
  }, 15000)

  it('does not turn green when Claude keeps working after a tool interrupt', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '运行 sleep 60' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: { task: '运行 sleep 60', ts: Date.now() / 1000 }
      })
    )
    const watcher = startInterruptWatcher()
    await delay(600)
    appendTranscriptLine({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        stop_reason: 'tool_use'
      }
    })
    appendTranscriptLine({
      type: 'user',
      message: { content: '[Request interrupted by user for tool use]' }
    })
    await delay(500)
    appendTranscriptLine({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '继续回答' }],
        stop_reason: 'end_turn'
      }
    })
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe('')
  }, 15000)

  it('ignores an interrupt recorded for an older turn', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '修复登录超时' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: {
          task: '修复登录超时',
          turn_started_at: 1000,
          ts: Date.now() / 1000
        }
      })
    )
    const watcher = startInterruptWatcher('2000')
    await delay(600)
    appendTranscriptLine({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: null
      }
    })
    appendTranscriptLine({
      type: 'user',
      message: { content: '[Request interrupted by user]' }
    })
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe('')
  }, 15000)

  it('turns green for the current turn token', async () => {
    writeFileSync(
      transcriptPath,
      transcriptLine({
        type: 'user',
        message: { content: '修复登录超时' }
      })
    )
    writeFileSync(
      statePath,
      JSON.stringify({
        [SESSION_ID]: {
          task: '修复登录超时',
          turn_started_at: 1000,
          ts: Date.now() / 1000
        }
      })
    )
    const watcher = startInterruptWatcher('1000')
    await delay(600)
    appendTranscriptLine({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: null
      }
    })
    appendTranscriptLine({
      type: 'user',
      message: { content: '[Request interrupted by user]' }
    })
    expect(await watcher.wait()).toBe(0)
    expect(watcher.output()).toBe(title('🟢', '修复登录超时'))
  }, 15000)
})
