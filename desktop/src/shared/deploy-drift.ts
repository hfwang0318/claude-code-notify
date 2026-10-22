import type { DeployMode, DeployProfile } from './types'

const MAX_DRIFT_ITEMS = 6

export interface DeployDriftInput {
  /** Mode of the local hook currently written to ~/.claude/settings.json. */
  localMode: DeployMode | null
  /** Mode the user currently wants (`prefs.mode`). */
  prefsMode: DeployMode
  profiles: DeployProfile[]
  /** Current hook version (`HOOK_VERSION`). */
  hookVersion: string
  /** Current callback address advertised to hooks. */
  localIp: string
  port: number
  /** Fingerprint of the current token; compared with deployed profiles. */
  tokenFingerprint: string
}

function modeLabel(mode: DeployMode): string {
  return mode === 'popup' ? '弹窗' : '系统通知'
}

function profileLabel(profile: DeployProfile): string {
  return profile.origin?.trim() || profile.name?.trim() || profile.host
}

/**
 * Describe how deployed hooks have drifted from the current app configuration.
 * Only deployed profiles are inspected; failed/unknown profiles are dormant.
 * Profiles deployed before token fingerprints existed are not treated as
 * drifted, otherwise every upgrade would light up the banner.
 */
export function computeDeployDrift(input: DeployDriftInput): string[] {
  const drift: string[] = []

  if (input.localMode && input.localMode !== input.prefsMode) {
    drift.push(
      `本机钩子模式需重新应用（${modeLabel(input.localMode)} → ${modeLabel(input.prefsMode)}）`
    )
  }

  for (const profile of input.profiles) {
    if (profile.status !== 'deployed') continue
    const label = profileLabel(profile)

    if (profile.mode !== input.prefsMode) {
      drift.push(
        `${label} 的钩子模式需重新应用（${modeLabel(profile.mode)} → ${modeLabel(input.prefsMode)}）`
      )
    }

    if (profile.hookVersion !== input.hookVersion) {
      drift.push(
        `${label} 的钩子版本需从 ${profile.hookVersion || '未知'} 更新到 ${input.hookVersion}`
      )
    }

    if (profile.callbackIp !== input.localIp || profile.callbackPort !== input.port) {
      drift.push(
        `${label} 的回调地址需更新（${profile.callbackIp}:${profile.callbackPort} → ${input.localIp}:${input.port}）`
      )
    }

    if (
      profile.tokenFingerprint &&
      input.tokenFingerprint &&
      profile.tokenFingerprint !== input.tokenFingerprint
    ) {
      drift.push(`${label} 的 Token 已变更，需要重新部署`)
    }
  }

  return [...new Set(drift)].slice(0, MAX_DRIFT_ITEMS)
}
