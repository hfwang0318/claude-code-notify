import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { LogLevel } from '../../shared/types'
import { hooksDirectory, quoteShell as shellQuote, timestamp } from './paths'
import {
  APPROVAL_SCRIPT_NAME,
  DEFAULT_PRE_TOOL_MATCHER,
  HOOK_VERSION,
  HOOK_VERSION_KEY,
  NOTIFY_SCRIPT_NAME,
  SHELL_RC_FILES,
  buildEnvBlock,
  buildHookCommand,
  mergeSettingsJson,
  removeEnvBlock,
  settingsHaveOurHooks,
  stripSettingsJson,
  type DeployMode
} from './settings'

export interface DeployConfig {
  mode: DeployMode
  host: string
  sshPort: number
  username: string
  authMethod: 'password' | 'key'
  password?: string
  keyPath?: string
  keyPassphrase?: string
  callbackIp: string
  callbackPort: number
  hookTimeout: number
  approvalTimeout: number
  toolMatcher?: string
  origin?: string
  envImport?: boolean
  envShells: string[]
  token: string
  hostFingerprint?: string
  trustHost?: boolean
}

export interface DeployProgress {
  (level: LogLevel, message: string): void
}

export interface FingerprintError extends Error {
  code?: 'HOST_KEY_UNKNOWN' | 'HOST_KEY_MISMATCH'
  fingerprint?: string
}

export const SSH_COMMAND_TIMEOUT = 'SSH_COMMAND_TIMEOUT'
export const DEPLOY_CANCELLED = 'DEPLOY_CANCELLED'

export const PYTHON_COMPILE_SNIPPET =
  "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')"

/** Build the remote syntax check without relying on a writable __pycache__. */
export function buildPythonCompileCommand(scriptPath: string): string {
  return `python3 -c "${PYTHON_COMPILE_SNIPPET}" ${shellQuote(scriptPath)}`
}

interface CodedError extends Error {
  code?: string
}

function codedError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  return error
}

function cancelledError(): CodedError {
  return codedError('部署已取消', DEPLOY_CANCELLED)
}

export function isDeployCancelled(error: unknown): boolean {
  return (error as { code?: string })?.code === DEPLOY_CANCELLED
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError()
}

function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export function humanizeSshError(error: unknown): string {
  const code = (error as { code?: string })?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === DEPLOY_CANCELLED) return '部署已取消'
  if (code === SSH_COMMAND_TIMEOUT) return 'SSH 命令执行超时，请检查网络或服务器负载'
  if ((error as { name?: string })?.name === 'AbortError') return '部署已取消'
  if (code === 'ENOTFOUND') return '找不到这台服务器，请检查主机名或 DNS'
  if (code === 'ECONNREFUSED') return 'SSH 端口拒绝连接，请检查端口与服务器 sshd 状态'
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) return '连接超时，请检查网络或防火墙'
  if (code === 'EHOSTUNREACH') return '服务器不可达，请检查网络'
  if (/All configured authentication methods failed/i.test(message)) {
    return 'SSH 认证失败，请检查用户名、密码或私钥'
  }
  if (/Cannot parse privateKey|no start line/i.test(message)) {
    return '无法解析私钥文件，请确认格式（OpenSSH / PEM）'
  }
  if (/Encrypted private OpenSSH key detected/i.test(message)) {
    return '私钥已加密，请填写私钥密码'
  }
  if (code === 'HOST_KEY_UNKNOWN') return '首次连接，需要确认服务器主机指纹'
  if (code === 'HOST_KEY_MISMATCH') return '主机指纹与已记录的指纹不一致，已中止连接'
  return message || 'SSH 连接失败'
}

export function execCommand(
  client: Client,
  command: string,
  timeout = 30000,
  signal?: AbortSignal
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stream: ClientChannel | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
        onAbort = null
      }
    }

    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }

    const fail = (error: unknown): void => {
      const channel = stream
      settle(() => {
        try {
          channel?.close()
        } catch {
          // stream may already be closed
        }
        reject(error)
      })
    }

    timer = setTimeout(() => {
      fail(
        codedError(
          `SSH 命令执行超时（${timeout}ms）：${command.slice(0, 80)}`,
          SSH_COMMAND_TIMEOUT
        )
      )
    }, timeout)

    if (signal) {
      if (signal.aborted) {
        fail(cancelledError())
        return
      }
      onAbort = (): void => fail(cancelledError())
      signal.addEventListener('abort', onAbort, { once: true })
    }

    client.exec(command, (error, channel) => {
      if (settled) {
        try {
          channel?.close()
        } catch {
          // the command already timed out or was cancelled
        }
        return
      }
      if (error) {
        fail(error)
        return
      }
      stream = channel
      let stdout = ''
      let stderr = ''
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      channel.on('close', (code: number) => {
        settle(() => resolve({ code: code ?? 0, stdout, stderr }))
      })
      channel.on('error', (streamError: Error) => {
        fail(streamError)
      })
    })
  })
}

function sftpWrite(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, content, (error) => (error ? reject(error) : resolve()))
  })
}

function sftpChmod(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (error) => (error ? reject(error) : resolve()))
  })
}

function sftpRead(sftp: SFTPWrapper, remotePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(data.toString('utf-8'))
    })
  })
}

interface ConnectState {
  fingerprint: string
}

function connectOptions(config: DeployConfig, state: ConnectState): ConnectConfig {
  const options: ConnectConfig = {
    host: config.host,
    port: config.sshPort,
    username: config.username,
    readyTimeout: 15000,
    hostVerifier: (key: Buffer): boolean => {
      state.fingerprint = fingerprintOf(key)
      if (config.trustHost) return true
      return Boolean(config.hostFingerprint) && state.fingerprint === config.hostFingerprint
    }
  }
  if (config.authMethod === 'password') {
    options.password = config.password
  } else {
    options.privateKey = readFileSync(config.keyPath || '')
    if (config.keyPassphrase) options.passphrase = config.keyPassphrase
  }
  return options
}

async function openClient(
  config: DeployConfig,
  signal?: AbortSignal
): Promise<{ client: Client; fingerprint: string }> {
  checkAborted(signal)
  const client = new Client()
  const state: ConnectState = { fingerprint: '' }
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        try {
          client.end()
        } catch {
          // the connection may not be established yet
        }
        reject(cancelledError())
      }
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      client.once('ready', () => finish())
      client.once('error', (error) => finish(error))
      client.connect(connectOptions(config, state))
    })
  } catch (error) {
    if (isDeployCancelled(error)) throw error
    const mismatch =
      Boolean(config.hostFingerprint) && state.fingerprint !== config.hostFingerprint
    const failure = new Error(humanizeSshError(error)) as FingerprintError
    if (!config.trustHost) {
      if (mismatch) failure.code = 'HOST_KEY_MISMATCH'
      else if (!config.hostFingerprint && state.fingerprint) failure.code = 'HOST_KEY_UNKNOWN'
    }
    failure.fingerprint = state.fingerprint
    throw failure
  }
  client.on('error', (error) => console.error('[ssh]', error))
  return { client, fingerprint: state.fingerprint }
}

function connectivityCommand(config: DeployConfig): string {
  const healthUrl = `http://${config.callbackIp}:${config.callbackPort}/health`
  return `curl -s -m 5 ${shellQuote(healthUrl)} || wget -q -T 5 -O- ${shellQuote(healthUrl)}`
}

export async function testSshConnection(
  config: DeployConfig,
  signal?: AbortSignal
): Promise<{
  ok: boolean
  message: string
  home?: string
  connectivity?: boolean
  connectivityMessage?: string
  fingerprint?: string
  knownFingerprint?: boolean
  code?: string
}> {
  let client: Client
  let fingerprint = ''
  try {
    const opened = await openClient(config, signal)
    client = opened.client
    fingerprint = opened.fingerprint
  } catch (error) {
    const failure = error as FingerprintError
    return {
      ok: false,
      message: humanizeSshError(error),
      fingerprint: failure.fingerprint,
      knownFingerprint: false,
      code: failure.code
    }
  }
  try {
    const result = await execCommand(client, 'echo $HOME', 30000, signal)
    const home = result.stdout.trim()
    if (result.code !== 0 || !home) {
      return { ok: false, message: 'SSH 已连接，但无法读取服务器 $HOME', fingerprint }
    }
    let connectivity = false
    let connectivityMessage = ''
    try {
      const check = await execCommand(client, connectivityCommand(config), 20000, signal)
      connectivity =
        check.stdout.includes('"status": "ok"') || check.stdout.includes('"status":"ok"')
      connectivityMessage = connectivity
        ? '服务器可以访问本机回调地址'
        : `服务器无法访问 http://${config.callbackIp}:${config.callbackPort}/health，请检查防火墙和回调 IP`
    } catch (error) {
      connectivityMessage = humanizeSshError(error)
    }
    return {
      ok: true,
      message: 'SSH 连接成功',
      home,
      connectivity,
      connectivityMessage,
      fingerprint,
      knownFingerprint: true
    }
  } catch (error) {
    return { ok: false, message: humanizeSshError(error), fingerprint }
  } finally {
    client.end()
  }
}

export async function deployToServer(
  config: DeployConfig,
  onProgress: DeployProgress,
  signal?: AbortSignal
): Promise<{ success: boolean; summary: string; connectivity: boolean; fingerprint: string }> {
  const log = (message: string, level: LogLevel = 'info'): void =>
    onProgress(level, message)

  checkAborted(signal)
  log(`连接服务器 ${config.username}@${config.host}:${config.sshPort} …`)
  const { client, fingerprint } = await openClient(config, signal)
  log('SSH 连接成功')

  try {
    checkAborted(signal)
    const homeResult = await execCommand(client, 'echo $HOME', 30000, signal)
    const home = homeResult.stdout.trim()
    if (homeResult.code !== 0 || !home) throw new Error('无法获取服务器上的 $HOME')

    const claudeDir = `${home}/.claude`
    checkAborted(signal)
    await execCommand(
      client,
      `mkdir -p ${shellQuote(claudeDir)} && chmod 700 ${shellQuote(claudeDir)}`,
      30000,
      signal
    )
    log(`创建目录 ${claudeDir}`)

    const isPopup = config.mode === 'popup'
    const scriptName = isPopup ? APPROVAL_SCRIPT_NAME : NOTIFY_SCRIPT_NAME
    const localScript = join(hooksDirectory(), scriptName)
    const scriptContent = readFileSync(localScript, 'utf-8')
    const remoteScript = `${claudeDir}/${scriptName}`
    const remoteNotifyScript = `${claudeDir}/${NOTIFY_SCRIPT_NAME}`

    checkAborted(signal)
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, value) => (error ? reject(error) : resolve(value)))
    })
    try {
      checkAborted(signal)
      log(`上传钩子脚本 → ${remoteScript}`)
      await sftpWrite(sftp, remoteScript, scriptContent)
      await sftpChmod(sftp, remoteScript, 0o755)
      checkAborted(signal)
      if (isPopup) {
        const notifyContent = readFileSync(
          join(hooksDirectory(), NOTIFY_SCRIPT_NAME),
          'utf-8'
        )
        log(`上传回合通知脚本 → ${remoteNotifyScript}`)
        await sftpWrite(sftp, remoteNotifyScript, notifyContent)
        await sftpChmod(sftp, remoteNotifyScript, 0o755)
      } else {
        await execCommand(
          client,
          `rm -f ${shellQuote(`${claudeDir}/${APPROVAL_SCRIPT_NAME}`)}`,
          30000,
          signal
        )
      }

      // Validate before touching settings.json. A broken upload must not leave
      // the server with hooks pointing at a script that cannot start.
      checkAborted(signal)
      log('验证钩子脚本 …')
      const pythonCheck = await execCommand(client, 'command -v python3', 15000, signal)
      if (pythonCheck.code !== 0 || !pythonCheck.stdout.trim()) {
        throw new Error('服务器没有可用的 python3')
      }
      const scriptsToVerify = isPopup ? [remoteScript, remoteNotifyScript] : [remoteScript]
      for (const scriptPath of scriptsToVerify) {
        const verify = await execCommand(
          client,
          buildPythonCompileCommand(scriptPath),
          20000,
          signal
        )
        if (verify.code !== 0) {
          const detail = verify.stderr.trim().slice(0, 300)
          throw new Error(
            `钩子脚本验证失败（${scriptPath}，exit=${verify.code}）${detail ? `：${detail}` : ''}`
          )
        }
      }
      log('钩子脚本验证通过')

      checkAborted(signal)
      const settingsPath = `${claudeDir}/settings.json`
      const existing = (await sftpRead(sftp, settingsPath)) || ''
      if (existing.trim()) {
        const backupPath = `${settingsPath}.bak.${timestamp()}`
        await execCommand(
          client,
          `cp ${shellQuote(settingsPath)} ${shellQuote(backupPath)}`,
          30000,
          signal
        )
        log(`已备份现有配置 → ${backupPath}`)
      }

      const baseUrl = `http://${config.callbackIp}:${config.callbackPort}`
      const envPairs: Record<string, string | number> =
        config.mode === 'popup'
          ? {
              CLAUDE_NOTIFY_TOKEN: config.token,
              CLAUDE_APPROVAL_URL: `${baseUrl}/claude-approval`,
              CLAUDE_NOTIFY_URL: `${baseUrl}/claude-notify`,
              CLAUDE_APPROVAL_TIMEOUT: config.approvalTimeout,
              CLAUDE_ASKUSER_CHANNEL: 'pretooluse',
              CLAUDE_NOTIFY_ORIGIN: config.origin || config.host,
              [HOOK_VERSION_KEY]: HOOK_VERSION
            }
          : {
              CLAUDE_NOTIFY_TOKEN: config.token,
              CLAUDE_NOTIFY_URL: `${baseUrl}/claude-notify`,
              CLAUDE_NOTIFY_ORIGIN: config.origin || config.host,
              [HOOK_VERSION_KEY]: HOOK_VERSION
            }
      if (config.mode === 'popup' && config.toolMatcher) {
        envPairs.CLAUDE_APPROVAL_MATCHER = config.toolMatcher
      }

      const hookCommand = buildHookCommand(envPairs, scriptName)
      const notifyEnvPairs: Record<string, string | number> = {
        CLAUDE_NOTIFY_TOKEN: config.token,
        CLAUDE_NOTIFY_URL: `${baseUrl}/claude-notify`,
        CLAUDE_NOTIFY_ORIGIN: config.origin || config.host,
        [HOOK_VERSION_KEY]: HOOK_VERSION
      }
      const stopCommand = buildHookCommand(notifyEnvPairs, NOTIFY_SCRIPT_NAME)
      log('合并钩子配置（清除未选模式的残留）…')
      const merged = mergeSettingsJson(existing, {
        mode: config.mode,
        hookEntry: { type: 'command', command: hookCommand },
        hookTimeout: config.hookTimeout,
        questionEntry: { type: 'command', command: hookCommand },
        stopEntry: { type: 'command', command: stopCommand },
        sessionEndEntry: { type: 'command', command: stopCommand },
        preToolMatcher: DEFAULT_PRE_TOOL_MATCHER
      })
      await sftpWrite(sftp, settingsPath, merged)
      await execCommand(client, `chmod 600 ${shellQuote(settingsPath)}`, 15000, signal)
      log(`已写入 ${settingsPath}`)

      if (config.envImport && config.envShells.length > 0) {
        for (const shell of config.envShells) {
          const info = SHELL_RC_FILES[shell]
          if (!info) continue
          checkAborted(signal)
          const rcFile = `${home}/${info.rc}`
          await execCommand(
            client,
            `mkdir -p $(dirname ${shellQuote(rcFile)}) && touch ${shellQuote(rcFile)}`,
            30000,
            signal
          )
          const current = (await sftpRead(sftp, rcFile)) || ''
          const block = buildEnvBlock(shell, config.token)
          await execCommand(
            client,
            `cp ${shellQuote(rcFile)} ${shellQuote(`${rcFile}.claude-notify-bak`)}`,
            30000,
            signal
          )
          const next = `${removeEnvBlock(current)}\n${block}\n`
          await sftpWrite(sftp, rcFile, next)
          log(`写入环境变量 → ${rcFile}（${info.label}）`)
        }
      }
    } finally {
      sftp.end()
    }

    checkAborted(signal)
    const healthUrl = `http://${config.callbackIp}:${config.callbackPort}/health`
    log(`测试服务器到本机的连通性 ${healthUrl} …`)
    const check = await execCommand(client, connectivityCommand(config), 20000, signal)
    const connectivity = check.stdout.includes('"status": "ok"') || check.stdout.includes('"status":"ok"')
    if (connectivity) {
      log('连通性测试通过 ✓', 'notify')
      return {
        success: true,
        connectivity: true,
        summary: '部署完成！Claude Code 的权限审批将推送到本机。',
        fingerprint
      }
    }
    log(
      `连通性测试失败：服务器无法访问本机。请检查防火墙是否放行端口 ${config.callbackPort}，以及回调 IP 是否正确。`,
      'warn'
    )
    return {
      success: true,
      connectivity: false,
      summary: '部署已写入，但连通性测试未通过，请检查防火墙。',
      fingerprint
    }
  } finally {
    client.end()
  }
}

export async function removeDeployFromServer(
  config: DeployConfig,
  onProgress: DeployProgress,
  signal?: AbortSignal
): Promise<{ success: boolean; summary: string; removedHooks: number }> {
  const log = (message: string, level: LogLevel = 'info'): void => onProgress(level, message)
  checkAborted(signal)
  log(`连接服务器 ${config.username}@${config.host}:${config.sshPort} …`)
  const { client } = await openClient(config, signal)
  try {
    checkAborted(signal)
    const homeResult = await execCommand(client, 'echo $HOME', 30000, signal)
    const home = homeResult.stdout.trim()
    if (homeResult.code !== 0 || !home) throw new Error('无法获取服务器上的 $HOME')
    const claudeDir = `${home}/.claude`
    const settingsPath = `${claudeDir}/settings.json`
    checkAborted(signal)
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, value) => (error ? reject(error) : resolve(value)))
    })
    let removedHooks = 0
    try {
      checkAborted(signal)
      const existing = await sftpRead(sftp, settingsPath)
      if (existing === null) {
        const exists = await execCommand(
          client,
          `test -f ${shellQuote(settingsPath)}`,
          5000,
          signal
        )
        if (exists.code === 0) {
          throw new Error('无法读取服务器 settings.json，已中止移除，未删除任何 hook 配置')
        }
      } else if (existing.trim()) {
        const backupPath = `${settingsPath}.bak.${timestamp()}`
        await execCommand(
          client,
          `cp ${shellQuote(settingsPath)} ${shellQuote(backupPath)}`,
          30000,
          signal
        )
        log(`已备份现有配置 → ${backupPath}`)
        const stripped = stripSettingsJson(existing)
        removedHooks = stripped.removed
        if (removedHooks === 0 && settingsHaveOurHooks(existing)) {
          throw new Error(
            'settings.json 中仍存在 Claude Notify hook，但格式无法识别；为避免误删第三方配置，已中止移除'
          )
        }
        if (stripped.changed) {
          await sftpWrite(sftp, settingsPath, stripped.text)
          await execCommand(client, `chmod 600 ${shellQuote(settingsPath)}`, 15000, signal)
          const verify = await sftpRead(sftp, settingsPath)
          if (!verify || settingsHaveOurHooks(verify)) {
            throw new Error('移除后 settings.json 仍检测到 Claude Notify hook，请检查文件权限或手动清理')
          }
          log(`已从 settings.json 移除 ${removedHooks} 个钩子条目`)
        }
      }
      checkAborted(signal)
      for (const script of [APPROVAL_SCRIPT_NAME, NOTIFY_SCRIPT_NAME, 'claude_notify_config.json']) {
        await execCommand(
          client,
          `rm -f ${shellQuote(`${claudeDir}/${script}`)}`,
          30000,
          signal
        )
      }
      log('已删除服务器上的钩子脚本')
      if (config.envImport && config.envShells.length > 0) {
        for (const shell of config.envShells) {
          const info = SHELL_RC_FILES[shell]
          if (!info) continue
          checkAborted(signal)
          const rcFile = `${home}/${info.rc}`
          const current = await sftpRead(sftp, rcFile)
          if (!current) continue
          const next = removeEnvBlock(current)
          if (next !== current) {
            await sftpWrite(sftp, rcFile, `${next}\n`)
            log(`已从 ${info.label} 配置移除 Token 环境变量`)
          }
        }
      }
    } finally {
      sftp.end()
    }
    log('服务器接入已断开', 'notify')
    return {
      success: true,
      removedHooks,
      summary: '服务器钩子已移除，Claude Code 将回到终端审批。'
    }
  } finally {
    client.end()
  }
}

export async function restoreDeployBackup(
  config: DeployConfig,
  onProgress: DeployProgress,
  signal?: AbortSignal
): Promise<{ success: boolean; summary: string; restoredFrom: string }> {
  const log = (message: string, level: LogLevel = 'info'): void => onProgress(level, message)
  checkAborted(signal)
  log(`连接服务器 ${config.username}@${config.host}:${config.sshPort} …`)
  const { client } = await openClient(config, signal)
  try {
    checkAborted(signal)
    const homeResult = await execCommand(client, 'echo $HOME', 30000, signal)
    const home = homeResult.stdout.trim()
    if (homeResult.code !== 0 || !home) throw new Error('无法获取服务器上的 $HOME')
    const settingsPath = `${home}/.claude/settings.json`
    checkAborted(signal)
    const listed = await execCommand(
      client,
      `ls -1t ${shellQuote(settingsPath)}.bak.* 2>/dev/null | head -n 1`,
      30000,
      signal
    )
    const restoredFrom = listed.stdout.trim().split('\n')[0]
    if (!restoredFrom) throw new Error('服务器上没有找到 settings.json 备份')
    checkAborted(signal)
    const safety = `${settingsPath}.pre-restore.${timestamp()}`
    await execCommand(
      client,
      `cp ${shellQuote(settingsPath)} ${shellQuote(safety)}`,
      30000,
      signal
    )
    await execCommand(
      client,
      `cp ${shellQuote(restoredFrom)} ${shellQuote(settingsPath)}`,
      30000,
      signal
    )
    await execCommand(client, `chmod 600 ${shellQuote(settingsPath)}`, 15000, signal)
    log(`已恢复 ${settingsPath} ← ${restoredFrom}`, 'notify')
    return {
      success: true,
      summary: `已恢复服务器配置 ← ${restoredFrom}`,
      restoredFrom
    }
  } finally {
    client.end()
  }
}
