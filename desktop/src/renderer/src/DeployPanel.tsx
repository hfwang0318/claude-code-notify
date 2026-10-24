import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/types'
import { api } from './api'
import DeployDialog from './DeployDialog'
import type { SettingsSection } from './Preferences'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  state: AppState
  onClose: () => void
  onOpenSettings: (section: SettingsSection) => void
}

function LocalIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  )
}

function ServerIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </svg>
  )
}

export default function DeployPanel({
  open,
  state,
  onClose,
  onOpenSettings
}: Props): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)

  useFocusTrap(open && !remoteOpen, dialogRef, onClose)

  useEffect(() => {
    if (!open) setRemoteOpen(false)
  }, [open])

  const localMode = state.deploy.localMode
  const profiles = state.deploy.profiles
  const latestProfile = profiles.find((profile) => profile.status === 'deployed')
  const deployedCount = profiles.filter((profile) => profile.status === 'deployed').length
  const localModeLabel = localMode === 'popup' ? '弹窗' : '通知'

  const connectLocal = async (): Promise<void> => {
    setLocalBusy(true)
    const response = await api.localDeploy(state.prefs.mode)
    setLocalBusy(false)
    if (response.ok && !state.onboarding.done) void api.finishOnboarding()
  }

  if (!open) return null

  return (
    <>
      <div className="modal-backdrop" role="presentation">
        <section
          className="deploy-modal deploy-panel-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deploy-panel-title"
          ref={dialogRef}
        >
          <header className="modal-head">
            <div>
              <div className="modal-kicker">部署</div>
              <h2 id="deploy-panel-title">接入 Claude Code</h2>
              <p>本机与远程服务器是两种并列的接入方式，选择一个目标完成部署。</p>
            </div>
            <button className="modal-close" onClick={onClose} aria-label="关闭部署">
              ×
            </button>
          </header>

          <div className="deploy-modal-body deploy-panel-body">
            <div className="deploy-choice-grid">
              <section className="card deploy-choice">
                <header className="deploy-choice-head">
                  <span className="deploy-choice-icon" aria-hidden="true">
                    <LocalIcon />
                  </span>
                  <div className="deploy-choice-title">
                    <h3>本机</h3>
                    <p>写入当前用户的 ~/.claude，无需额外配置。</p>
                  </div>
                  <span className={`deploy-choice-state ${localMode ? 'ok' : 'idle'}`}>
                    {localMode ? '已接入' : '未接入'}
                  </span>
                </header>

                <dl className="deploy-choice-meta">
                  <div>
                    <dt>接入状态</dt>
                    <dd>
                      {localMode ? `已接入 · ${localModeLabel}模式` : '尚未接入本机'}
                    </dd>
                  </div>
                  <div>
                    <dt>本机 Hook</dt>
                    <dd>
                      {state.deploy.hookVersion ? `v${state.deploy.hookVersion}` : '未检测'}
                      {state.deploy.hookStale ? ' · 需要更新' : ''}
                    </dd>
                  </div>
                </dl>

                {state.deploy.hookStale ? (
                  <div className="inline-warning">
                    本机 Hook 版本落后，重新接入会保留第三方 hooks 并更新到最新版。
                  </div>
                ) : null}

                <div className="deploy-choice-actions">
                  <button
                    className="btn primary"
                    disabled={localBusy}
                    onClick={() => void connectLocal()}
                  >
                    {localBusy ? '接入中…' : localMode ? '重新接入本机' : '接入本机'}
                  </button>
                  {localMode ? (
                    <>
                      <button
                        className="btn subtle compact"
                        onClick={() => void api.removeLocal()}
                      >
                        断开本机
                      </button>
                      <button
                        className="btn subtle compact"
                        onClick={() => void api.restoreLocal()}
                      >
                        恢复备份
                      </button>
                    </>
                  ) : null}
                </div>

                <p className="deploy-choice-note">
                  会合并 settings.json 并自动备份；提醒方式在
                  <button className="link" onClick={() => onOpenSettings('popup')}>
                    设置
                  </button>
                  中调整。
                </p>
              </section>

              <section className="card deploy-choice">
                <header className="deploy-choice-head">
                  <span className="deploy-choice-icon" aria-hidden="true">
                    <ServerIcon />
                  </span>
                  <div className="deploy-choice-title">
                    <h3>远程服务器</h3>
                    <p>通过 SSH 写入服务器的 ~/.claude，并从服务器验证回调。</p>
                  </div>
                  <span className={`deploy-choice-state ${deployedCount > 0 ? 'ok' : 'idle'}`}>
                    {deployedCount > 0 ? `${deployedCount} 个已部署` : '未部署'}
                  </span>
                </header>

                <dl className="deploy-choice-meta">
                  <div>
                    <dt>最近部署</dt>
                    <dd>
                      {latestProfile
                        ? `${latestProfile.username}@${latestProfile.host}:${latestProfile.sshPort}`
                        : '尚未配置服务器'}
                    </dd>
                  </div>
                  <div>
                    <dt>已保存目标</dt>
                    <dd>{profiles.length > 0 ? `${profiles.length} 个` : '无'}</dd>
                  </div>
                </dl>

                {state.deploy.drift.length > 0 ? (
                  <div className="inline-warning">
                    {state.deploy.drift[0]}
                    <button className="link" onClick={() => setRemoteOpen(true)}>
                      重新部署
                    </button>
                  </div>
                ) : null}

                <div className="deploy-choice-actions">
                  <button className="btn primary" onClick={() => setRemoteOpen(true)}>
                    {profiles.length > 0 ? '管理远程部署' : '配置远程部署'}
                  </button>
                </div>

                <p className="deploy-choice-note">
                  部署前会测试连接并校验 SSH 主机指纹；已保存的目标可复用。
                </p>
              </section>
            </div>

            {state.deploy.modeMismatch ? (
              <div className="inline-warning deploy-panel-warning">
                已部署钩子仍使用旧的提醒模式
                <button className="link" onClick={() => onOpenSettings('popup')}>
                  去设置调整
                </button>
              </div>
            ) : null}

            <p className="deploy-panel-footnote">
              部署状态会同步到“状态”页；已部署的钩子需要重新接入或部署后才会应用新配置。
            </p>
          </div>
        </section>
      </div>

      <DeployDialog
        open={remoteOpen}
        state={state}
        onClose={() => setRemoteOpen(false)}
      />
    </>
  )
}
