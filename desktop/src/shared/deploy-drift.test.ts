import { describe, expect, it } from 'vitest'
import { computeDeployDrift, type DeployDriftInput } from './deploy-drift'
import type { DeployProfile } from './types'

const CURRENT_TOKEN = '0123456789abcdef'

function profile(overrides: Partial<DeployProfile> = {}): DeployProfile {
  return {
    id: 'deploy@10.0.0.5:22',
    name: 'prod-api',
    origin: 'prod-api',
    host: '10.0.0.5',
    sshPort: 22,
    username: 'deploy',
    authMethod: 'key',
    mode: 'popup',
    callbackIp: '192.168.1.20',
    callbackPort: 18765,
    hookTimeout: 300,
    toolMatcher: '',
    lastDeployAt: 1,
    status: 'deployed',
    hooks: 2,
    hookVersion: '2',
    tokenFingerprint: CURRENT_TOKEN,
    ...overrides
  }
}

function input(overrides: Partial<DeployDriftInput> = {}): DeployDriftInput {
  return {
    localMode: null,
    prefsMode: 'popup',
    profiles: [profile()],
    hookVersion: '2',
    localIp: '192.168.1.20',
    port: 18765,
    tokenFingerprint: CURRENT_TOKEN,
    ...overrides
  }
}

describe('deploy drift', () => {
  it('reports no drift when local and remote deployments match preferences', () => {
    expect(
      computeDeployDrift(
        input({
          localMode: 'popup',
          profiles: [profile()]
        })
      )
    ).toEqual([])
  })

  it('reports a local mode mismatch', () => {
    const drift = computeDeployDrift(input({ localMode: 'notify', profiles: [] }))
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('本机钩子模式需重新应用')
  })

  it('does not report a remote profile that intentionally uses another mode', () => {
    expect(computeDeployDrift(input({ prefsMode: 'notify' }))).toEqual([])
  })

  it('reports a stale remote hook version with the target name', () => {
    const drift = computeDeployDrift(
      input({ profiles: [profile({ hookVersion: '1' })] })
    )
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('prod-api')
    expect(drift[0]).toContain('1')
    expect(drift[0]).toContain('2')
  })

  it('reports callback ip and port changes', () => {
    const drift = computeDeployDrift(
      input({
        localIp: '10.0.0.9',
        port: 19000,
        profiles: [profile()]
      })
    )
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('prod-api')
    expect(drift[0]).toContain('192.168.1.20:18765')
    expect(drift[0]).toContain('10.0.0.9:19000')
  })

  it('reports a token change only when both fingerprints are present', () => {
    const drift = computeDeployDrift(
      input({ profiles: [profile({ tokenFingerprint: 'fedcba9876543210' })] })
    )
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('prod-api')
    expect(drift[0]).toContain('Token')
  })

  it('does not report a token change for profiles deployed before fingerprints', () => {
    const drift = computeDeployDrift(
      input({ profiles: [profile({ tokenFingerprint: undefined })] })
    )
    expect(drift).toEqual([])
  })

  it('ignores profiles that are not deployed', () => {
    const drift = computeDeployDrift(
      input({
        profiles: [
          profile({ status: 'failed', mode: 'notify', hookVersion: '1', tokenFingerprint: 'old' })
        ]
      })
    )
    expect(drift).toEqual([])
  })

  it('deduplicates repeated messages and caps the list at six items', () => {
    const profiles = Array.from({ length: 8 }, (_, index) =>
      profile({
        id: `deploy@10.0.0.${index}:22`,
        name: `server-${index}`,
        origin: `server-${index}`,
        host: `10.0.0.${index}`,
        hookVersion: '1'
      })
    )
    const drift = computeDeployDrift(input({ prefsMode: 'notify', profiles }))
    expect(drift).toHaveLength(6)
    expect(new Set(drift).size).toBe(drift.length)

    const duplicated = computeDeployDrift(
      input({
        profiles: [profile({ hookVersion: '1' }), profile({ id: 'duplicate-id', hookVersion: '1' })]
      })
    )
    expect(duplicated).toHaveLength(1)
    expect(duplicated[0]).toContain('钩子版本')
  })
})
