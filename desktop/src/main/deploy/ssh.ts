import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { LogLevel } from '../../shared/types'
import { hooksDirectory, quoteShell as shellQuote, timestamp } from './paths'
import {
  APPROVAL_SCRIPT_NAME,
  HOOK_VERSION,
  HOOK_VERSION_KEY,
  NOTIFY_SCRIPT_NAME,
  SHELL_RC_FILES,
  buildEnvBlock,
  buildHookCommand,
  mergeSettingsJson,
  removeEnvBlock,
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

function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export function humanizeSshError(error: unknown): string {
  const code = (error as { code?: string })?.code
  const message = error instanceof Error ? error.message : String(error)
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

function execCommand(
  client: Client,
  command: string,
  timeout = 30000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    void timeout
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      stream.on('close', (code: number) => {
        resolve({ code: code ?? 0, stdout, stderr })
      })
      stream.on('error', reject)
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
  config: DeployConfig
): Promise<{ client: Client; fingerprint: string }> {
  const client = new Client()
  const state: ConnectState = { fingerprint: '' }
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve())
      client.once('error', (error) => reject(error))
      client.connect(connectOptions(config, state))
    })
  } catch (error) {
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

export async function testSshConnection(config: DeployConfig): Promise<{
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
    const opened = await openClient(config)
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
    const result = await execCommand(client, 'echo $HOME')
    const home = result.stdout.trim()
    if (result.code !== 0 || !home) {
      return { ok: false, message: 'SSH 已连接，但无法读取服务器 $HOME', fingerprint }
    }
    let connectivity = false
    let connectivityMessage = ''
    try {
      const check = await execCommand(client, connectivityCommand(config), 20000)
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
  onProgress: DeployProgress
): Promise<{ success: boolean; summary: string; connectivity: boolean; fingerprint: string }> {
  const log = (message: string, level: LogLevel = 'info'): void =>
    onProgress(level, message)

  log(`连接服务器 ${config.username}@${config.host}:${config.sshPort} …`)
  const { client, fingerprint } = await openClient(config)
  log('SSH 连接成功')

  try {
    const homeResult = await execCommand(client, 'echo $HOME')
    const home = homeResult.stdout.trim()
    if (homeResult.code !== 0 || !home) throw new Error('无法获取服务器上的 $HOME')

    const claudeDir = `${home}/.claude`
    await execCommand(client, `mkdir -p ${shellQuote(claudeDir)} && chmod 700 ${shellQuote(claudeDir)}`)
    log(`创建目录 ${claudeDir}`)

    const scriptName = config.mode === 'popup' ? APPROVAL_SCRIPT_NAME : NOTIFY_SCRIPT_NAME
    const removedScript = config.mode === 'popup' ? NOTIFY_SCRIPT_NAME : APPROVAL_SCRIPT_NAME
    const localScript = join(hooksDirectory(), scriptName)
    const scriptContent = readFileSync(localScript, 'utf-8')
    const remoteScript = `${claudeDir}/${scriptName}`

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, value) => (error ? reject(error) : resolve(value)))
    })
    try {
      log(`上传钩子脚本 → ${remoteScript}`)
      await sftpWrite(sftp, remoteScript, scriptContent)
      await sftpChmod(sftp, remoteScript, 0o755)
      await execCommand(client, `rm -f ${shellQuote(`${claudeDir}/${removedScript}`)}`)

      const settingsPath = `${claudeDir}/settings.json`
      const existing = (await sftpRead(sftp, settingsPath)) || ''
      if (existing.trim()) {
        const backupPath = `${settingsPath}.bak.${timestamp()}`
        await execCommand(client, `cp ${shellQuote(settingsPath)} ${shellQuote(backupPath)}`)
        log(`已备份现有配置 → ${backupPath}`)
      }

      const baseUrl = `http://${config.callbackIp}:${config.callbackPort}`
      const envPairs: Record<string, string | number> =
        config.mode === 'popup'
          ? {
              CLAUDE_NOTIFY_TOKEN: config.token,
              CLAUDE_APPROVAL_URL: `${baseUrl}/claude-approval`,
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
      log('合并钩子配置（清除未选模式的残留）…')
      const merged = mergeSettingsJson(existing, {
        mode: config.mode,
        hookEntry: { type: 'command', command: hookCommand },
        hookTimeout: config.hookTimeout,
        questionEntry: { type: 'command', command: hookCommand }
      })
      await sftpWrite(sftp, settingsPath, merged)
      log(`已写入 ${settingsPath}`)

      if (config.envImport && config.envShells.length > 0) {
        for (const shell of config.envShells) {
          const info = SHELL_RC_FILES[shell]
          if (!info) continue
          const rcFile = `${home}/${info.rc}`
          await execCommand(client, `mkdir -p $(dirname ${shellQuote(rcFile)}) && touch ${shellQuote(rcFile)}`)
          const current = (await sftpRead(sftp, rcFile)) || ''
          const block = buildEnvBlock(shell, config.token)
          await execCommand(
            client,
            `cp ${shellQuote(rcFile)} ${shellQuote(`${rcFile}.claude-notify-bak`)}`
          )
          const next = `${removeEnvBlock(current)}\n${block}\n`
          await sftpWrite(sftp, rcFile, next)
          log(`写入环境变量 → ${rcFile}（${info.label}）`)
        }
      }
    } finally {
      sftp.end()
    }

    log('验证钩子脚本 …')
    const verify = await execCommand(
      client,
      `printf '{}' | timeout 10 python3 ${shellQuote(remoteScript)} >/dev/null 2>&1; echo $?`,
      20000
    )
    if (verify.code !== 0) log(`钩子脚本验证异常（exit=${verify.code}）`, 'warn')
    else log('钩子脚本验证通过')

    const healthUrl = `http://${config.callbackIp}:${config.callbackPort}/health`
    log(`测试服务器到本机的连通性 ${healthUrl} …`)
    const check = await execCommand(client, connectivityCommand(config), 20000)
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
  onProgress: DeployProgress
): Promise<{ success: boolean; summary: string; removedHooks: number }> {
  const log = (message: string, level: LogLevel = 'info'): void => onProgress(level, message)
  log(`连接服务器 ${config.username}@${config.host}:${config.sshPort} …`)
  const { client } = await openClient(config)
  try {
    const homeResult = await execCommand(client, 'echo $HOME')
    const home = homeResult.stdout.trim()
    if (homeResult.code !== 0 || !home) throw new Error('无法获取服务器上的 $HOME')
    const claudeDir = `${home}/.claude`
    const settingsPath = `${claudeDir}/settings.json`
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, value) => (error ? reject(error) : resolve(value)))
    })
    let removedHooks = 0
    try {
      const existing = await sftpRead(sftp, settingsPath)
      if (existing && existing.trim()) {
        const backupPath = `${settingsPath}.bak.${timestamp()}`
        await execCommand(client, `cp ${shellQuote(settingsPath)} ${shellQuote(backupPath)}`)
        log(`已备份现有配置 → ${backupPath}`)
        const stripped = stripSettingsJson(existing)
        removedHooks = stripped.removed
        if (stripped.changed) {
          await sftpWrite(sftp, settingsPath, stripped.text)
          log(`已从 settings.json 移除 ${removedHooks} 个钩子条目`)
        }
      }
      for (const script of [APPROVAL_SCRIPT_NAME, NOTIFY_SCRIPT_NAME, 'claude_notify_config.json']) {
        await execCommand(client, `rm -f ${shellQuote(`${claudeDir}/${script}`)}`)
      }
      log('已删除服务器上的钩子脚本')
      if (config.envImport && config.envShells.length > 0) {
        for (const shell of config.envShells) {
          const info = SHELL_RC_FILES[shell]
          if (!info) continue
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
  onProgress: DeployProgress
): Promise<{ success: boolean; summary: string; restoredFrom: string }> {
  const log = (message: string, level: LogLevel = 'info'): void => onProgress(level, message)
  log(`连接服务器 ${config.username}@${config.host}:${config.sshPort} …`)
  const { client } = await openClient(config)
  try {
    const homeResult = await execCommand(client, 'echo $HOME')
    const home = homeResult.stdout.trim()
    if (homeResult.code !== 0 || !home) throw new Error('无法获取服务器上的 $HOME')
    const settingsPath = `${home}/.claude/settings.json`
    const listed = await execCommand(
      client,
      `ls -1t ${shellQuote(settingsPath)}.bak.* 2>/dev/null | head -n 1`
    )
    const restoredFrom = listed.stdout.trim().split('\n')[0]
    if (!restoredFrom) throw new Error('服务器上没有找到 settings.json 备份')
    const safety = `${settingsPath}.pre-restore.${timestamp()}`
    await execCommand(client, `cp ${shellQuote(settingsPath)} ${shellQuote(safety)}`)
    await execCommand(
      client,
      `cp ${shellQuote(restoredFrom)} ${shellQuote(settingsPath)}`
    )
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
