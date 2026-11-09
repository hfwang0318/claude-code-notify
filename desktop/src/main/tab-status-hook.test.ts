import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

  it('stores the first prompt once and marks only one title attempt', () => {
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
})
