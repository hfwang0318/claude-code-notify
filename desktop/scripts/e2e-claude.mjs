#!/usr/bin/env node
/**
 * Real Claude Code end-to-end test for Claude Notify.
 *
 * It never touches ~/.claude/settings.json or the user's app data. It creates
 * an isolated CLAUDE_NOTIFY_DATA_DIR, an isolated Electron user-data dir and an
 * isolated Claude settings file that only contains our hooks plus the auth
 * fields copied from the user's settings (apiKeyHelper / env / model).
 *
 * Usage:
 *   pnpm e2e:claude
 *   E2E_CASES=multi,resolved,timeout pnpm e2e:claude
 *   E2E_KEEP=1 pnpm e2e:claude          # keep temp logs for debugging
 *   E2E_SKIP_BUILD=1 pnpm e2e:claude    # reuse existing out/
 *   E2E_REQUIRE_CLAUDE=1 pnpm e2e:claude
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin =
  process.platform === 'win32'
    ? join(desktopRoot, 'node_modules', '.bin', 'electron.CMD')
    : join(desktopRoot, 'node_modules', '.bin', 'electron')
const claudeBin = process.env.CLAUDE_BIN || 'claude'
// Some Claude Code sessions start with only ToolSearch/Web registered. Asking
// for Bash explicitly is not enough there; loading it first makes the real
// approval cases deterministic instead of silently skipping.
const BASH_TOOL_HINT =
  'If the Bash tool is not already available, first use the ToolSearch tool to load it. '
// Mirrors HOOK_PAUSE_BUDGET_SEC in the app: the hook process must outlive a
// paused popup countdown, not just the initial approval window.
const PAUSE_BUDGET_SEC = 600
const keepTemp = process.env.E2E_KEEP === '1'
const skipBuild = process.env.E2E_SKIP_BUILD === '1'
const requireClaude = process.env.E2E_REQUIRE_CLAUDE === '1'
const requestedCases = new Set(
  (process.env.E2E_CASES || 'all').split(',').map((value) => value.trim())
)
const shouldRun = (name) => requestedCases.has('all') || requestedCases.has(name)
const origin = process.env.E2E_ORIGIN || 'e2e-claude'
const tempRoot = mkdtempSync(join(tmpdir(), 'claude-notify-e2e-'))
const dataDir = join(tempRoot, 'data')
const electronDir = join(tempRoot, 'electron')
const claudeDir = join(tempRoot, 'claude')
const logsDir = join(tempRoot, 'logs')
const workRoot = join(tempRoot, 'work')
const appLog = join(tempRoot, 'app.log')
const pendingFile = join(dataDir, 'pending.json')
const historyFile = join(dataDir, 'history.jsonl')
const sessionsFile = join(dataDir, 'sessions.json')
const children = new Set()
let app = null
let cdp = null
let port = 0
let debugPortRef = 0
let token = ''
let settingsFile = ''
let timeoutSettingsFile = ''
const startedAt = Date.now()

function log(message) {
  console.log(`[e2e] ${message}`)
}

function skip(reason) {
  console.log(`\nE2E SKIP: ${reason}`)
  cleanup()
  process.exit(requireClaude ? 1 : 0)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, probe, timeout = 30000, interval = 200) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
      lastError = null
    } catch (error) {
      lastError = error
    }
    await delay(interval)
  }
  throw new Error(
    `等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`
  )
}

function hasToolUnavailable(output) {
  return /(no|not|n't|never).*(Bash|Write|Edit|tool)|(Bash|Write|Edit)[^.]{0,80}(not|n't|unavailable|no matches)|tool registry|only callable tool|not available in this environment|no files? (were|was) created/i.test(
    output
  )
}

function sessionToolUnavailable(session) {
  if (!existsSync(session.outFile)) return false
  const output = readFileSync(session.outFile, 'utf-8')
  return hasToolUnavailable(output) || /^BLOCKED\s*$/m.test(output)
}

async function waitPendingWithToolCheck(
  count,
  sessions,
  timeout = 60000,
  sessionIds = null
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const pending = readJson(pendingFile, [])
    const relevant = sessionIds
      ? pending.filter((item) => sessionIds.includes(item.sessionId))
      : pending
    if (count === 0 ? relevant.length === 0 : relevant.length >= count) return relevant
    if (sessions.some(sessionToolUnavailable)) {
      if (process.env.E2E_REQUIRE_TOOLS === '1') {
        throw new Error('Claude 当前会话没有暴露 Bash/Write/Edit，E2E_REQUIRE_TOOLS=1')
      }
      return null
    }
    await delay(250)
  }
  if (process.env.E2E_REQUIRE_TOOLS === '1') {
    throw new Error(`等待超时：pending=${count}（E2E_REQUIRE_TOOLS=1）`)
  }
  log(`  ⚠ 等待 ${count} 条 pending 超时，按当前 Claude 工具不可用跳过`)
  return null
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

function readHistory() {
  if (!existsSync(historyFile)) return []
  return readFileSync(historyFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const value = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(value))
    })
  })
}

function checkPrerequisites() {
  if (process.platform === 'win32') {
    skip('当前 E2E 脚本只支持 macOS/Linux（Windows 的 hook 命令需要单独适配）')
  }
  if (!existsSync(electronBin)) {
    throw new Error(`找不到 Electron：${electronBin}，请先 pnpm install`)
  }
  if (typeof WebSocket !== 'function') {
    throw new Error('当前 Node 没有全局 WebSocket；请使用 Node 22+')
  }
  const version = spawnSync(claudeBin, ['--version'], { encoding: 'utf-8' })
  if (version.error || version.status !== 0) {
    skip(`找不到可用的 Claude Code CLI（${claudeBin}）`)
  }
  log(`Claude Code: ${String(version.stdout).trim()}`)
  const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' })
  if (python.error || python.status !== 0) {
    skip('找不到 python3；真实 hook 需要它')
  }
}

function buildApp() {
  if (skipBuild) {
    if (!existsSync(join(desktopRoot, 'out', 'main', 'index.js'))) {
      throw new Error('E2E_SKIP_BUILD=1 但 out/main/index.js 不存在')
    }
    log('跳过构建（E2E_SKIP_BUILD=1）')
    return
  }
  log('构建应用（pnpm build）…')
  const build = spawnSync('pnpm', ['build'], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: { ...process.env }
  })
  if (build.status !== 0) throw new Error('pnpm build 失败')
}

function loadAuthSettings() {
  const source = process.env.E2E_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json')
  if (!existsSync(source)) {
    skip(`找不到 Claude 设置文件：${source}`)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(source, 'utf-8'))
  } catch (error) {
    skip(`Claude 设置文件不是合法 JSON：${String(error)}`)
  }
  if (!parsed.apiKeyHelper && process.env.E2E_ALLOW_NO_KEY_HELPER !== '1') {
    skip(
      '隔离配置需要 apiKeyHelper 才能复用登录态；可在 E2E_CLAUDE_SETTINGS 指定包含 apiKeyHelper/env/model 的设置文件，或设置 E2E_ALLOW_NO_KEY_HELPER=1 自行尝试'
    )
  }
  return {
    apiKeyHelper: parsed.apiKeyHelper,
    env: parsed.env,
    model: parsed.model
  }
}

function buildSettings(auth, approvalTimeout) {
  const approvalHook = [
    `CLAUDE_NOTIFY_TOKEN=${shellQuote(token)}`,
    `CLAUDE_APPROVAL_URL=${shellQuote(`http://127.0.0.1:${port}/claude-approval`)}`,
    `CLAUDE_APPROVAL_TIMEOUT=${shellQuote(String(approvalTimeout))}`,
    "CLAUDE_ASKUSER_CHANNEL='pretooluse'",
    `CLAUDE_NOTIFY_ORIGIN=${shellQuote(origin)}`,
    `python3 ${shellQuote(join(desktopRoot, 'resources', 'hooks', 'claude_approval_hook.py'))}`
  ].join(' ')
  const notifyHook = [
    `CLAUDE_NOTIFY_TOKEN=${shellQuote(token)}`,
    `CLAUDE_NOTIFY_URL=${shellQuote(`http://127.0.0.1:${port}/claude-notify`)}`,
    `CLAUDE_NOTIFY_ORIGIN=${shellQuote(origin)}`,
    `python3 ${shellQuote(join(desktopRoot, 'resources', 'hooks', 'claude_notify_hook.py'))}`
  ].join(' ')
  const settings = {
    // Some routed models only expose tools that have an explicit permission
    // rule. "ask" keeps Bash/Write/Edit visible while still forcing the real
    // PermissionRequest hook (unlike "allow", which would skip the popup).
    permissions: { defaultMode: 'default', ask: ['Bash', 'Write', 'Edit'] },
    hooks: {
      PermissionRequest: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: approvalHook,
              timeout: approvalTimeout + 60 + PAUSE_BUDGET_SEC
            }
          ]
        }
      ],
      PreToolUse: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: approvalHook,
              timeout: approvalTimeout + 60 + PAUSE_BUDGET_SEC
            }
          ]
        }
      ],
      Notification: [
        { matcher: '', hooks: [{ type: 'command', command: notifyHook, timeout: 30 }] }
      ],
      ...(process.env.E2E_NO_STOP
        ? {}
        : {
            Stop: [
              { matcher: '', hooks: [{ type: 'command', command: notifyHook, timeout: 30 }] }
            ]
          })
    }
  }
  if (auth.apiKeyHelper) settings.apiKeyHelper = auth.apiKeyHelper
  if (auth.env) settings.env = auth.env
  if (auth.model) settings.model = auth.model
  return settings
}

function writeSettings(auth) {
  const normal = join(tempRoot, 'claude-settings.json')
  const timeout = join(tempRoot, 'claude-settings-timeout.json')
  settingsFile = normal
  timeoutSettingsFile = timeout
  writeFileSync(normal, JSON.stringify(buildSettings(auth, 120), null, 2), { mode: 0o600 })
  writeFileSync(timeout, JSON.stringify(buildSettings(auth, 20), null, 2), { mode: 0o600 })
}

function probeAuth() {
  if (process.env.E2E_SKIP_AUTH_PROBE === '1') return
  log('探测隔离配置下的 Claude 认证…')
  const result = spawnSync(
    claudeBin,
    [
      '--setting-sources',
      '',
      '--settings',
      settingsFile,
      '-p',
      '--output-format',
      'text',
      'Reply with exactly OK'
    ],
    { encoding: 'utf-8', timeout: 90000, env: { ...process.env } }
  )
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 400)
    skip(`Claude 认证探测失败，请确认登录态/apiKeyHelper：${detail}`)
  }
  log('认证探测通过')
}

async function launchApp() {
  port = await freePort()
  const debugPort = await freePort()
  token = `e2e_${randomBytes(24).toString('hex')}`
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
  mkdirSync(logsDir, { recursive: true })
  mkdirSync(workRoot, { recursive: true })
  writeFileSync(join(dataDir, 'token'), `${token}\n`, { mode: 0o600 })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    CLAUDE_NOTIFY_PORT: String(port),
    CLAUDE_NOTIFY_DATA_DIR: dataDir,
    CLAUDE_NOTIFY_CLAUDE_DIR: claudeDir,
    CLAUDE_NOTIFY_THEME: process.env.E2E_THEME || 'dark',
    CLAUDE_NOTIFY_OPAQUE: '1'
  })
  const out = openSync(appLog, 'a')
  app = spawn(
    electronBin,
    ['.', `--user-data-dir=${electronDir}`, `--remote-debugging-port=${debugPort}`],
    { cwd: desktopRoot, env, stdio: ['ignore', out, out] }
  )
  children.add(app)
  app.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] app exited with code ${code}`)
    }
  })

  const base = `http://127.0.0.1:${port}`
  await waitFor('应用 /health', async () => {
    const response = await fetch(`${base}/health`)
    return response.ok ? true : null
  }, 30000, 300)
  log(`应用已启动：${base}`)

  await waitFor('Electron CDP', async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    return response.ok ? true : null
  }, 20000, 300)

  debugPortRef = debugPort
  log('Electron CDP 已就绪')
}

async function ensurePopupCdp() {
  if (cdp) return
  const target = await waitFor('popup CDP target', async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPortRef}/json`)).json()
    return targets.find((entry) => entry.url.endsWith('#popup')) || null
  }, 20000, 200)
  cdp = await connectCdp(target.webSocketDebuggerUrl)
  log('CDP 已连接 popup')
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
  })
  let id = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data)
    if (!data.id) return
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.error) entry.reject(new Error(data.error.message))
    else entry.resolve(data.result)
  }
  return {
    async send(method, params) {
      const callId = ++id
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject })
        socket.send(JSON.stringify({ id: callId, method, params }))
      })
    },
    async eval(expression, awaitPromise = false) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise
      })
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            'CDP evaluate failed'
        )
      }
      return result.result?.value
    },
    close() {
      socket.close()
    }
  }
}

async function getState() {
  return cdp.eval('window.desktop.getState()', true)
}

async function waitPending(count, timeout = 60000) {
  return waitFor(
    `pending=${count}`,
    () => {
      const pending = readJson(pendingFile, [])
      const ready = count === 0 ? pending.length === 0 : pending.length >= count
      return ready ? pending : null
    },
    timeout,
    150
  )
}

function startClaude(label, sessionId, settings, prompt, permissionMode = 'default') {
  const workDir = join(workRoot, label)
  mkdirSync(workDir, { recursive: true })
  const outFile = join(logsDir, `${label}.out`)
  const errFile = join(logsDir, `${label}.err`)
  const out = openSync(outFile, 'w')
  const err = openSync(errFile, 'w')
  const modeArgs =
    permissionMode === 'dangerously-skip'
      ? ['--dangerously-skip-permissions']
      : ['--permission-mode', permissionMode]
  const child = spawn(
    claudeBin,
    [
      '--setting-sources',
      '',
      '--settings',
      settings,
      ...modeArgs,
      '--session-id',
      sessionId,
      '-p',
      '--output-format',
      'text',
      prompt
    ],
    {
      cwd: workDir,
      env: { ...process.env },
      stdio: ['ignore', out, err]
    }
  )
  children.add(child)
  return { label, sessionId, workDir, outFile, errFile, child }
}

function waitExit(child, timeout = 60000) {
  return Promise.race([
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode)
      child.once('exit', (code) => resolve(code))
    }),
    delay(timeout).then(() => {
      child.kill('SIGTERM')
      return null
    })
  ])
}

function assertDone(session) {
  const output = existsSync(session.outFile)
    ? readFileSync(session.outFile, 'utf-8')
    : ''
  assert(output.includes('DONE'), `${session.label} 未输出 DONE：${output.slice(0, 200)}`)
  assert(
    existsSync(join(session.workDir, 'result.txt')),
    `${session.label} 未生成 result.txt`
  )
}

function recordFor(session) {
  return readHistory().find(
    (record) => record.sessionKey === `${origin}:${session.sessionId}`
  )
}

async function runBypassProbe(permissionMode, label, prefix, description) {
  const session = startClaude(
    label,
    randomUUID(),
    settingsFile,
    `Fix the ${prefix} workspace files. ${BASH_TOOL_HINT}Use the Bash tool to run \`pwd > ${prefix}-bash.txt\`. Then create ${prefix}-write.txt with content OK and change it to OK!. Prefer the Write and Edit tools when they are available; otherwise use Bash. Do not ask permission. After the files exist, reply with exactly DONE.`,
    permissionMode
  )
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (session.child.exitCode !== null) break
    const pending = readJson(pendingFile, [])
    assert(
      pending.length === 0,
      `${description} 下产生了审批：${pending.map((item) => item.sessionLabel).join(', ')}`
    )
    await delay(250)
  }
  const code = await waitExit(session.child, 120000)
  assert(code !== null, `${description} 会话未在 120s 内结束（疑似被审批卡住）`)
  const output = existsSync(session.outFile)
    ? readFileSync(session.outFile, 'utf-8')
    : ''
  const done = /(^|\n)DONE\s*$/m.test(output)
  if (!done && hasToolUnavailable(output) && process.env.E2E_REQUIRE_TOOLS !== '1') {
    log(`  ⚠ ${description}: Claude 当前会话没有暴露 Bash/Write/Edit，跳过这个入口`)
    return false
  }
  assert(done, `${description} 会话未输出 DONE：${output.slice(0, 200)}`)
  assert(existsSync(join(session.workDir, `${prefix}-bash.txt`)), `${description} Bash 没有执行`)
  assert(
    existsSync(join(session.workDir, `${prefix}-write.txt`)),
    `${description} Write 没有执行`
  )
  assert(
    readFileSync(join(session.workDir, `${prefix}-write.txt`), 'utf-8').includes('OK!'),
    `${description} Edit 没有执行`
  )
  await waitPending(0, 5000)
  assert(!recordFor(session), `${description} 不应写入审批历史`)
  return true
}

async function waitSessionPending(sessionId, count = 0, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const pending = readJson(pendingFile, []).filter(
      (item) => item.sessionId === sessionId
    )
    if (count === 0 ? pending.length === 0 : pending.length >= count) return pending
    await delay(150)
  }
  throw new Error(`等待超时：session=${sessionId} pending=${count}`)
}

async function drainPending() {
  for (let round = 0; round < 3; round += 1) {
    const pending = readJson(pendingFile, [])
    if (pending.length === 0) {
      await delay(400)
      if (readJson(pendingFile, []).length === 0) return
      continue
    }
    for (const item of pending) {
      if (!item.requestId) continue
      await fetch(`http://127.0.0.1:${port}/claude-approval-resolved`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ request_id: item.requestId })
      }).catch(() => undefined)
    }
    await waitPending(0, 8000)
  }
}

async function runBypassCase() {
  log('用例 1/5：bypass 权限下 Bash + 文件工具不触发审批')
  const permissionMode = await runBypassProbe(
    'bypassPermissions',
    'work-bypass',
    'bypass',
    '--permission-mode bypassPermissions'
  )
  const dangerouslySkip = await runBypassProbe(
    'dangerously-skip',
    'work-bypass-flag',
    'bypass-flag',
    '--dangerously-skip-permissions'
  )
  if (permissionMode && dangerouslySkip) {
    log('  ✓ 两种 bypass 入口下 Bash + 文件写入执行，pending=0，history 无审批记录')
  } else if (permissionMode || dangerouslySkip) {
    log('  ✓ 可用的 bypass 入口通过；另一个入口因当前会话工具注册表不可用而跳过')
  } else {
    log('  ⚠ 当前 Claude 会话未暴露 Bash/Write/Edit，bypass 真机用例跳过；hook 工具矩阵测试仍覆盖守卫')
  }
}

async function runStopCase() {
  log('用例 2/5：真实 Claude 回合结束触发 Stop 通知')
  const logFile = join(dataDir, 'claude-notify.log')
  const before = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : ''
  const session = startClaude(
    'work-stop',
    randomUUID(),
    settingsFile,
    'Reply with exactly DONE. Do not use any tool.'
  )
  const code = await waitExit(session.child, 60000)
  assert(code !== null, 'Stop 会话未结束')
  const output = existsSync(session.outFile)
    ? readFileSync(session.outFile, 'utf-8')
    : ''
  assert(output.includes('DONE'), `Stop 会话未输出 DONE：${output.slice(0, 200)}`)
  await waitFor(
    'Stop 通知到达应用',
    async () => {
      const current = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : ''
      return current.slice(before.length).includes('收到通知：type=Stop')
    },
    15000,
    100
  )
  log('  ✓ Claude 回合结束后应用收到 Stop 通知')
}

async function runMultiSessionCase() {
  log('用例 3/5：两路真实 Claude 会话并发 + 会话条切换')
  await drainPending()
  const first = startClaude(
    'work-a',
    randomUUID(),
    settingsFile,
    `Fix the login redirect regression. ${BASH_TOOL_HINT}Use the Bash tool to run: pwd && date +%s > result.txt . After the tool succeeds, reply with exactly DONE.`
  )
  const second = startClaude(
    'work-b',
    randomUUID(),
    settingsFile,
    `Audit the payment retry loop. ${BASH_TOOL_HINT}Use the Bash tool to run: pwd && date +%s > result.txt . After the tool succeeds, reply with exactly DONE.`
  )

  const pendingNow = await waitPendingWithToolCheck(2, [first, second], 120000, [
    first.sessionId,
    second.sessionId
  ])
  if (!pendingNow) {
    log('  ⚠ 当前 Claude 会话没有暴露 Bash，双会话用例跳过')
    first.child.kill('SIGTERM')
    second.child.kill('SIGTERM')
    await waitExit(first.child, 5000)
    await waitExit(second.child, 5000)
    await drainPending()
    return
  }
  await ensurePopupCdp()
  await waitFor(
    '弹窗渲染 2 个会话',
    async () => {
      const count = await cdp.eval("document.querySelectorAll('.session-chip').length")
      return count >= 2 ? count : null
    },
    8000,
    100
  )
  const state = await getState()
  assert(state.pending.length === 2, `预期 2 条待审批，实际 ${state.pending.length}`)
  const sessions = state.sessions.filter((entry) => entry.state === 'waiting')
  assert(sessions.length === 2, `预期 2 个等待会话，实际 ${sessions.length}`)
  const colors = new Set(sessions.map((entry) => entry.color))
  assert(colors.size === 2, '两个会话的颜色没有去重')
  const labels = state.pending.map((entry) => entry.sessionLabel)
  assert(labels.every((label) => !label.includes('dumb')), `TERM=dumb 泄漏到标签：${labels.join(', ')}`)

  const chipCount = await cdp.eval(
    "document.querySelectorAll('.session-chip').length"
  )
  assert(chipCount === 2, `弹窗会话条数量应为 2，实际 ${chipCount}`)
  const queueText = await cdp.eval(
    "document.querySelector('.popup-queue-toggle')?.textContent || ''"
  )
  assert(queueText.includes('2 个会话'), `队列文案异常：${queueText}`)

  // Every approval must carry a real task summary from the transcript and a
  // stable short session id — the two things that disambiguate parallel work.
  // v4 puts the current task in the H1, so that is the primary assertion.
  const identityTask = await cdp.eval(
    "document.querySelector('.popup-title')?.textContent?.trim() || ''"
  )
  assert(identityTask.length > 0, '弹窗标题没有当前任务摘要')
  const identityId = await cdp.eval(
    "document.querySelector('.popup-identity .identity-id')?.textContent?.trim() || ''"
  )
  assert(/^#[0-9a-z]{4}$/.test(identityId), `会话短码异常：${identityId}`)
  const chipTasks = await cdp.eval(
    "Array.from(document.querySelectorAll('.session-chip-task')).map((entry) => entry.textContent.trim())"
  )
  assert(
    chipTasks.every((task) => task && task !== '暂无任务摘要'),
    `会话条任务摘要缺失：${JSON.stringify(chipTasks)}`
  )
  assert(
    new Set(chipTasks).size === chipTasks.length,
    `并发会话的任务摘要没有区分开：${JSON.stringify(chipTasks)}`
  )
  const chipNames = await cdp.eval(
    "Array.from(document.querySelectorAll('.session-chip-name')).map((entry) => entry.textContent.trim())"
  )
  assert(
    chipNames.length === 2 && new Set(chipNames).size === 2,
    `两个并发会话的会话名没有区分开：${JSON.stringify(chipNames)}`
  )

  // Switch to the second session explicitly before approving it.
  const targetLabel = await cdp.eval(
    "document.querySelectorAll('.session-chip')[1]?.querySelector('.session-chip-name')?.textContent || ''"
  )
  assert(targetLabel, '第二个会话条没有标签')
  const firstHeadline = await cdp.eval(
    "document.querySelector('.popup-title')?.textContent?.trim() || ''"
  )
  await cdp.eval("document.querySelectorAll('.session-chip')[1]?.click()")
  await waitFor(
    '切换到第二个会话',
    async () => {
      const active = await cdp.eval(
        "document.querySelector('.popup-session-label')?.textContent || document.querySelector('.session-chip.active .session-chip-name')?.textContent || ''"
      )
      return active === targetLabel ? true : null
    },
    5000,
    100
  )
  const secondHeadline = await cdp.eval(
    "document.querySelector('.popup-title')?.textContent?.trim() || ''"
  )
  assert(
    secondHeadline && secondHeadline !== firstHeadline,
    `切换会话后任务标题没有变化：${firstHeadline} -> ${secondHeadline}`
  )
  const activeChip = await cdp.eval(
    "Array.from(document.querySelectorAll('.session-chip')).find((entry) => entry.classList.contains('active'))?.textContent || ''"
  )
  assert(activeChip.length > 0, '点击会话条后没有 active 会话')

  await cdp.eval("document.querySelector('.popup-btn.allow')?.click()")
  await waitPending(1)
  // Give React a frame to swap the card to the remaining session before the
  // second click; clicking the resolved card's stale button would be a no-op.
  await waitFor(
    '弹窗切换到剩余会话',
    async () => {
      const label = await cdp.eval(
        "document.querySelector('.popup-session-label')?.textContent || document.querySelector('.session-chip.active .session-chip-name')?.textContent || ''"
      )
      return label && label !== targetLabel ? label : null
    },
    5000,
    100
  )
  await cdp.eval("document.querySelector('.popup-btn.allow')?.click()")
  await waitPending(0, 20000)
  await Promise.all([waitExit(first.child, 60000), waitExit(second.child, 60000)])
  assertDone(first)
  assertDone(second)
  const storedSessions = readJson(sessionsFile, {})
  const storedColors = new Set()
  for (const session of [first, second]) {
    const record = recordFor(session)
    assert(record, `缺少 ${session.label} 的历史记录`)
    assert(record.decision === 'allow', `${session.label} 历史决策不是 allow`)
    assert(record.source === 'popup', `${session.label} 历史来源不是 popup`)
    const stored = storedSessions[`${origin}:${session.sessionId}`]
    assert(stored, `sessions.json 缺少 ${session.label}`)
    assert(stored.origin === origin, `sessions.json origin 错误：${stored.origin}`)
    storedColors.add(stored.color)
  }
  assert(storedColors.size === 2, 'sessions.json 中两个会话的颜色没有去重')
  log('  ✓ 双会话并发、会话条切换、逐条批准、DONE、result.txt、history 全部通过')
}

async function runResolvedCase() {
  log('用例 4/5：终端侧已处理（/claude-approval-resolved）')
  await drainPending()
  const session = startClaude(
    'work-resolved',
    randomUUID(),
    settingsFile,
    `${BASH_TOOL_HINT}Use the Bash tool to run: pwd && date +%s > result.txt . If the Bash tool does not succeed, do not use any other tool; reply with exactly BLOCKED.`
  )
  const pendingNow = await waitPendingWithToolCheck(1, [session], 60000, [
    session.sessionId
  ])
  if (!pendingNow) {
    log('  ⚠ 当前 Claude 会话没有暴露 Bash，resolved 用例跳过')
    session.child.kill('SIGTERM')
    await waitExit(session.child, 5000)
    await drainPending()
    return
  }
  await ensurePopupCdp()
  const state = await getState()
  const pending = state.pending.find((item) => item.sessionId === session.sessionId)
  assert(pending, `没有当前会话的待审批：${session.label}`)
  const response = await fetch(`http://127.0.0.1:${port}/claude-approval-resolved`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ request_id: pending.requestId })
  })
  assert(response.ok, `resolved 接口返回 ${response.status}`)
  const body = await response.json()
  assert(body.status === 'resolved', `resolved 返回异常：${JSON.stringify(body)}`)
  await waitSessionPending(session.sessionId, 0, 15000)
  session.child.kill('SIGTERM')
  await waitExit(session.child, 5000)
  await drainPending()
  const record = recordFor(session)
  assert(record, '缺少终端处理的历史记录')
  assert(record.decision === 'cancelled', `终端处理决策应为 cancelled，实际 ${record.decision}`)
  assert(record.source === 'terminal', `终端处理来源应为 terminal，实际 ${record.source}`)
  log('  ✓ resolved、pending 清空、history=cancelled/terminal 通过')
}

async function runTimeoutCase() {
  log('用例 5/5：真实 Claude 请求超时回退 + expired 确认')
  await drainPending()
  const session = startClaude(
    'work-timeout',
    randomUUID(),
    timeoutSettingsFile,
    `${BASH_TOOL_HINT}Use the Bash tool to run: pwd && date +%s > result.txt . If the Bash tool does not succeed, do not use any other tool; reply with exactly BLOCKED.`
  )
  const pendingNow = await waitPendingWithToolCheck(1, [session], 60000, [
    session.sessionId
  ])
  if (!pendingNow) {
    log('  ⚠ 当前 Claude 会话没有暴露 Bash，timeout 用例跳过')
    session.child.kill('SIGTERM')
    await waitExit(session.child, 5000)
    await drainPending()
    return
  }
  await ensurePopupCdp()

  // The countdown must survive a pause longer than the server timeout. The
  // hook process gets the same pause budget, otherwise it would abandon the
  // HTTP request while the user is still typing.
  await cdp.eval("document.querySelector('.popup-pause')?.click()")
  await delay(6000)
  const pausedState = await getState()
  assert(
    pausedState.pending.some(
      (item) => item.sessionId === session.sessionId && item.paused
    ),
    '暂停 6s 后审批已消失（暂停没有冻结服务端超时）'
  )
  const pauseLabel = await cdp.eval(
    "document.querySelector('.popup-pause')?.textContent?.trim() || ''"
  )
  assert(pauseLabel.includes('继续'), `暂停按钮未切换为继续：${pauseLabel}`)
  await cdp.eval("document.querySelector('.popup-pause')?.click()")
  log('  ✓ 暂停 6s 未回退，恢复后继续倒计时')

  await waitSessionPending(session.sessionId, 0, 25000)
  const state = await getState()
  assert(state.expired.length > 0, '超时后 expired 为空')
  const record = recordFor(session)
  assert(record, '缺少超时历史记录')
  assert(record.decision === 'timeout', `超时决策应为 timeout，实际 ${record.decision}`)
  assert(record.source === 'timeout', `超时来源应为 timeout，实际 ${record.source}`)
  session.child.kill('SIGTERM')
  await waitExit(session.child, 5000)
  await drainPending()
  await cdp.eval('window.desktop.acknowledgeExpired()', true)
  await waitFor(
    'expired 清空',
    async () => {
      const next = await getState()
      return next.expired.length === 0 ? true : null
    },
    10000,
    150
  )
  log('  ✓ timeout、expired、确认清空、history=timeout/timeout 通过')
}

async function main() {
  console.log('Claude Notify · 真实 Claude Code E2E\n')
  checkPrerequisites()
  buildApp()
  const auth = loadAuthSettings()
  await launchApp()
  writeSettings(auth)
  probeAuth()

  const started = Date.now()
  if (shouldRun('bypass')) await runBypassCase()
  if (shouldRun('stop')) await runStopCase()
  if (shouldRun('multi')) await runMultiSessionCase()
  if (shouldRun('resolved')) await runResolvedCase()
  if (shouldRun('timeout')) await runTimeoutCase()

  await drainPending()
  if (cdp) {
    const state = await getState()
    assert(state.pending.length === 0, `测试结束仍有 ${state.pending.length} 条待审批`)
    assert(state.expired.length === 0, `测试结束仍有 ${state.expired.length} 条 expired`)
  } else {
    const pending = readJson(pendingFile, [])
    assert(pending.length === 0, `测试结束仍有 ${pending.length} 条待审批`)
  }

  console.log(
    `\nE2E PASS · ${requestedCases.has('all') ? 'all' : [...requestedCases].join(',')} · ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`
  )
  if (keepTemp) {
    console.log(`  artifacts: ${logsDir}`)
    console.log(`  history:   ${historyFile}`)
    console.log(`  sessions:  ${sessionsFile}`)
  }
  cleanup(true)
  process.exit(0)
}

function cleanup(success = false) {
  for (const child of children) {
    try {
      if (child.exitCode === null) child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  if (cdp) {
    try {
      cdp.close()
    } catch {
      // ignore
    }
  }
  if (app && app.exitCode === null) {
    try {
      app.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  if (keepTemp || !success) {
    console.log(`\n[e2e] 调试目录保留：${tempRoot}`)
    return
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

process.on('SIGINT', () => {
  cleanup(false)
  process.exit(130)
})

main().catch((error) => {
  console.error(`\nE2E FAIL: ${error instanceof Error ? error.message : String(error)}`)
  if (existsSync(appLog)) {
    const tail = readFileSync(appLog, 'utf-8').trim().split('\n').slice(-20).join('\n')
    if (tail) console.error(`\n--- app.log ---\n${tail}`)
  }
  if (existsSync(historyFile)) {
    console.error(`\n--- history.jsonl ---\n${readFileSync(historyFile, 'utf-8')}`)
  }
  cleanup(false)
  process.exit(1)
})

