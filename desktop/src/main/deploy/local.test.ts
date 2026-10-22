import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLocalHookEntry,
  deployLocal,
  detectLocalDeploy,
  detectLocalState,
  removeLocalDeploy,
  restoreLocalBackup
} from './local'
import { HOOK_VERSION, HOOK_VERSION_KEY } from './settings'

const directories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-notify-local-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe('deployLocal', () => {
  it('writes hooks, config, backup, and preserves third-party hooks', () => {
    const claudeDir = tempDir()
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            PermissionRequest: [
              { matcher: '', hooks: [{ type: 'command', command: 'echo third-party' }] }
            ]
          }
        },
        null,
        2
      )
    )

    const result = deployLocal(
      {
        mode: 'popup',
        token: 'test-token',
        port: 18765,
        timeoutSec: 240,
        writeEnv: false,
        envShells: [],
        claudeDir,
        hooksDir: join(process.cwd(), 'resources', 'hooks')
      },
      () => undefined
    )

    expect(existsSync(result.scriptPath)).toBe(true)
    expect(existsSync(result.configPath)).toBe(true)
    expect(detectLocalDeploy(claudeDir)).toBe('popup')

    const settings = JSON.parse(readFileSync(result.settingsPath, 'utf-8'))
    expect(settings.hooks.PermissionRequest).toHaveLength(2)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(JSON.stringify(settings.hooks.Stop)).toContain('claude_notify_hook.py')
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toBe('echo third-party')
    const installedHook = settings.hooks.PermissionRequest[1].hooks[0]
    if (process.platform === 'win32') {
      expect(installedHook.command).toMatch(/python(\.exe)?$/i)
      expect(installedHook.args).toEqual([result.scriptPath])
    } else {
      expect(installedHook.command).toContain('claude_approval_hook.py')
      expect(installedHook.command).toContain("CLAUDE_NOTIFY_TOKEN='test-token'")
    }

    const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(config.CLAUDE_NOTIFY_TOKEN).toBe('test-token')
    expect(config.CLAUDE_APPROVAL_URL).toBe('http://127.0.0.1:18765/claude-approval')
    expect(config[HOOK_VERSION_KEY]).toBe(HOOK_VERSION)
    expect(config.CLAUDE_ASKUSER_CHANNEL).toBe('pretooluse')
    expect(config.CLAUDE_NOTIFY_URL).toBe('http://127.0.0.1:18765/claude-notify')
    expect(existsSync(join(claudeDir, 'claude_notify_hook.py'))).toBe(true)

    const backups = readFileSync(result.settingsPath, 'utf-8')
    expect(backups).toContain('third-party')
  })

  it('restricts settings.json permissions to 0600 on POSIX', () => {
    const claudeDir = tempDir()
    const result = deployLocal(
      {
        mode: 'popup',
        token: 'test-token',
        port: 18765,
        timeoutSec: 240,
        writeEnv: false,
        envShells: [],
        claudeDir,
        hooksDir: join(process.cwd(), 'resources', 'hooks')
      },
      () => undefined
    )
    if (process.platform !== 'win32') {
      expect(statSync(result.settingsPath).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps settings.json private after remove and restore on POSIX', () => {
    const claudeDir = tempDir()
    deployLocal(
      {
        mode: 'notify',
        token: 'test-token',
        port: 18765,
        writeEnv: false,
        envShells: [],
        claudeDir,
        hooksDir: join(process.cwd(), 'resources', 'hooks')
      },
      () => undefined
    )
    const settingsPath = join(claudeDir, 'settings.json')
    removeLocalDeploy({ claudeDir }, () => undefined)
    if (process.platform !== 'win32') {
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
    }
    restoreLocalBackup(claudeDir, () => undefined)
    if (process.platform !== 'win32') {
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
    }
  })

  it('marks an old or missing hook version as stale', () => {
    const claudeDir = tempDir()
    const base = {
      mode: 'popup' as const,
      token: 'test-token',
      port: 18765,
      timeoutSec: 240,
      writeEnv: false,
      envShells: [],
      claudeDir,
      hooksDir: join(process.cwd(), 'resources', 'hooks')
    }
    deployLocal(base, () => undefined)
    expect(detectLocalState(claudeDir).stale).toBe(false)

    const configPath = join(claudeDir, 'claude_notify_config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config[HOOK_VERSION_KEY] = '1'
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    expect(detectLocalState(claudeDir).stale).toBe(true)

    delete config[HOOK_VERSION_KEY]
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    expect(detectLocalState(claudeDir).stale).toBe(true)
  })

  it('is idempotent on repeated local deploys', () => {
    const claudeDir = tempDir()
    const base = {
      mode: 'popup' as const,
      token: 'test-token',
      port: 18765,
      timeoutSec: 240,
      writeEnv: false,
      envShells: [],
      claudeDir,
      hooksDir: join(process.cwd(), 'resources', 'hooks')
    }
    deployLocal(base, () => undefined)
    const result = deployLocal(base, () => undefined)
    const settings = JSON.parse(readFileSync(result.settingsPath, 'utf-8'))
    expect(settings.hooks.PermissionRequest).toHaveLength(1)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
  })
})

describe('buildLocalHookEntry', () => {
  it('uses exec form with an absolute interpreter on Windows', () => {
    const entry = buildLocalHookEntry(
      { CLAUDE_NOTIFY_TOKEN: 't' },
      'C:\\Users\\me\\.claude\\claude_approval_hook.py',
      'win32',
      'C:\\Python313\\python.exe'
    )
    expect(entry).toEqual({
      type: 'command',
      command: 'C:\\Python313\\python.exe',
      args: ['C:\\Users\\me\\.claude\\claude_approval_hook.py']
    })
  })

  it('quotes paths and values on POSIX', () => {
    const entry = buildLocalHookEntry(
      { CLAUDE_NOTIFY_TOKEN: "a'b" },
      "/Users/me/My Clips/.claude/hook.py",
      'darwin'
    )
    expect(entry.command).toContain("CLAUDE_NOTIFY_TOKEN='a'\\''b'")
    expect(entry.command).toContain("python3 '/Users/me/My Clips/.claude/hook.py'")
  })
})

it('supports notification mode locally', () => {
  const claudeDir = tempDir()
  const result = deployLocal(
    {
      mode: 'notify',
      token: 'test-token',
      port: 18765,
      writeEnv: false,
      envShells: [],
      claudeDir,
      hooksDir: join(process.cwd(), 'resources', 'hooks')
    },
    () => undefined
  )
  const settings = JSON.parse(readFileSync(result.settingsPath, 'utf-8'))
  expect(settings.hooks.Notification).toHaveLength(1)
  expect(settings.hooks.Notification[0].hooks[0].timeout).toBe(30)
  expect(settings.hooks.PermissionRequest).toBeUndefined()
  expect(JSON.stringify(settings.hooks.Stop)).toContain('claude_notify_hook.py')
  const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
  expect(config.CLAUDE_NOTIFY_URL).toBe('http://127.0.0.1:18765/claude-notify')
  expect(detectLocalDeploy(claudeDir)).toBe('notify')
})
