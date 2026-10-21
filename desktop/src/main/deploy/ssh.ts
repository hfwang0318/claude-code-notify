import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hooksDirectory, quoteShell as shellQuote, timestamp } from './paths'
import { Client, type SFTPWrapper } from 'ssh2'
import type { LogLevel } from '../../shared/types'
import {
  APPROVAL_SCRIPT_NAME,
  NOTIFY_SCRIPT_NAME,
  ENV_MARK_BEGIN,
  ENV_MARK_END,
  SHELL_RC_FILES,
  buildEnvBlock,
  buildHookCommand,
  mergeSettingsJson,
  removeEnvBlock,
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
  envShells: string[]
  token: string
}

export interface DeployProgress {
  (level: LogLevel, message: string): void
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

function connectOptions(config: DeployConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {
    host: config.host,
    port: config.sshPort,
    username: config.username,
    readyTimeout: 15000,
    // 与 Paramiko AutoAddPolicy 行为一致；后续可换成首次信任 + 指纹固定。
    hostVerifier: () => true
  }
  if (config.authMethod === 'password') {
    options.password = config.password
  } else {
    options.privateKey = readFileSync(config.keyPath || '')
    if (config.keyPassphrase) options.passphrase = config.keyPassphrase
  }
  return options
}

async function openClient(config: DeployConfig): Promise<Client> {
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.once('error', (error) => reject(error))
    client.connect(connectOptions(config))
  })
  client.on('error', (error) => console.error('[ssh]', error))
  return client
}

export async function testSshConnection(
  config: DeployConfig
): Promise<{ ok: boolean; message: string; home?: string }> {
  let client: Client
  try {
    client = await openClient(config)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  try {
    const result = await execCommand(client, 'echo $HOME')
    const home = result.stdout.trim()
    if (result.code !== 0 || !home) {
      return { ok: false, message: 'SSH 已连接，但无法读取服务器 $HOME' }
    }
    return { ok: true, message: 'SSH 连接成功', home }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    client.end()
  }
}

export async function deployToServer(
  config: DeployConfig,
  onProgress: DeployProgress
): Promise<{ success: boolean; summary: string; connectivity: boolean }> {
  const log = (message: string, level: LogLevel = 'info'): void =>
    onProgress(level, message)

  log(`连接服务器 ${config.username}@${config.host}:${config.sshPort} …`)
  const client = await openClient(config)
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
              CLAUDE_ASKUSER_CHANNEL: 'pretooluse'
            }
          : {
              CLAUDE_NOTIFY_TOKEN: config.token,
              CLAUDE_NOTIFY_URL: `${baseUrl}/claude-notify`
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

      if (config.envShells.length > 0) {
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
    const check = await execCommand(
      client,
      `curl -s -m 5 ${shellQuote(healthUrl)} || wget -q -T 5 -O- ${shellQuote(healthUrl)}`,
      20000
    )
    const connectivity = check.stdout.includes('"status": "ok"') || check.stdout.includes('"status":"ok"')
    if (connectivity) {
      log('连通性测试通过 ✓', 'notify')
      return {
        success: true,
        connectivity: true,
        summary: '部署完成！Claude Code 的权限审批将推送到本机。'
      }
    }
    log(
      `连通性测试失败：服务器无法访问本机。请检查防火墙是否放行端口 ${config.callbackPort}，以及回调 IP 是否正确。`,
      'warn'
    )
    return {
      success: true,
      connectivity: false,
      summary: '部署已写入，但连通性测试未通过，请检查防火墙。'
    }
  } finally {
    client.end()
  }
}
