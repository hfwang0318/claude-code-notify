import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/types'
import { api } from './api'
import type { SettingsSection } from './Preferences'
import { maskToken } from './format'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  state: AppState
  onClose: () => void
  onOpenSettings: (section: SettingsSection) => void
}

export default function StatusDialog({
  open,
  state,
  onClose,
  onOpenSettings
}: Props): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null)
  const [showToken, setShowToken] = useState(false)

  useFocusTrap(open, dialogRef, onClose)

  useEffect(() => {
    if (!open) setShowToken(false)
  }, [open])

  const address = `http://${state.server.localIp}:${state.server.port}`
  const serviceOk = state.server.listening
  const latestProfile = state.deploy.profiles.find((profile) => profile.status === 'deployed')
  const localMode = state.deploy.localMode
  const waitingSessions = new Set(state.pending.map((item) => item.sessionKey)).size

  const copyToken = (): void => void api.copy(state.server.token)
  const copyConnectCommand = (): void =>
    void api.copy(
      `curl -X POST ${address}/claude-notify \\\n  -H "Authorization: Bearer ${state.server.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"message":"hello"}'`
    )

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="deploy-modal status-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-title"
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <div className="modal-kicker">状态</div>
            <h2 id="status-title">服务、连接与诊断</h2>
            <p>这里只汇总运行状态；接入和部署在独立的“部署”入口，提醒方式在设置里调整。</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭状态">
            ×
          </button>
        </header>

        <div className="deploy-modal-body status-modal-body">
          <div className="statusbar modal-statusbar" role="group" aria-label="运行状态">
            <div className="status-cell">
              <span className="status-key">服务</span>
              <span className={`status-value ${serviceOk ? 'ok' : 'muted'}`}>
                {serviceOk ? 'HTTP · 正常' : 'HTTP · 已停止'}
              </span>
              <span className="status-sub">
                {state.network.bindMode === 'all' ? '局域网' : '仅本机'} · {state.server.port}
              </span>
            </div>
            <div className="status-cell">
              <span className="status-key">接入</span>
              <span className="status-value info">
                {localMode
                  ? '本机 · 已接入'
                  : latestProfile
                    ? `${latestProfile.origin || latestProfile.host} · ${latestProfile.hooks} hooks`
                    : '尚未部署'}
              </span>
              <span className="status-sub">
                {state.deploy.hookStale
                  ? 'Hook 需要更新'
                  : state.deploy.modeMismatch
                    ? '提醒模式需重新应用'
                    : state.deploy.message}
              </span>
            </div>
            <div className="status-cell">
              <span className="status-key">队列</span>
              <span className={`status-value ${state.pending.length > 0 ? 'alert' : ''}`}>
                {state.pending.length} 条待审批
              </span>
              <span className="status-sub">
                {waitingSessions} 个会话 · 历史 {state.history.length} 条
              </span>
            </div>
          </div>

          <div className="status-grid">
            <section className="card">
              <header className="card-head">
                <span className="card-title">连接与凭证</span>
                <span className="card-hint">Bearer</span>
              </header>
              <dl className="kv">
                <dt>服务地址</dt>
                <dd title={address}>{address}</dd>
                <dt>本机 IP</dt>
                <dd>
                  {state.server.localIps.length > 1 ? (
                    <select
                      className="ip-select"
                      value={state.server.localIp}
                      onChange={(event) => void api.setPrefs({ localIp: event.target.value })}
                      aria-label="选择对外展示的本机 IP"
                    >
                      {state.server.localIps.map((ip) => (
                        <option key={ip} value={ip}>
                          {ip}
                        </option>
                      ))}
                    </select>
                  ) : (
                    state.server.localIp
                  )}
                </dd>
                <dt>Token</dt>
                <dd className="token-row">
                  <span title={showToken ? state.server.token : '已隐藏'}>
                    {showToken ? state.server.token : maskToken(state.server.token)}
                  </span>
                  <button
                    className="link"
                    onClick={() => setShowToken((value) => !value)}
                    aria-label={showToken ? '隐藏 Token' : '显示 Token'}
                  >
                    {showToken ? '隐藏' : '显示'}
                  </button>
                </dd>
                <dt>已推送</dt>
                <dd>{state.server.notified} 条通知</dd>
              </dl>
              <div className="row">
                <button className="btn" onClick={copyToken}>
                  复制 Token
                </button>
                <button className="btn" onClick={copyConnectCommand}>
                  复制接入命令
                </button>
                <button className="btn subtle" onClick={() => void api.regenerateToken()}>
                  重新生成
                </button>
              </div>
              <div className="card-footnote">
                {state.network.bindMode === 'all'
                  ? '监听 0.0.0.0：局域网可访问，Bearer Token + 明文 HTTP'
                  : '仅监听 127.0.0.1：外部服务器需要隧道'}
                <button className="link" onClick={() => onOpenSettings('network')}>
                  网络设置
                </button>
              </div>
            </section>

            <section className="card">
              <header className="card-head">
                <span className="card-title">运行与诊断</span>
                <span className="card-hint">v{state.app.version}</span>
              </header>
              <div className="diag-grid">
                <div className="diag-cell">
                  <span>HTTP 服务</span>
                  <b className={serviceOk ? 'ok' : 'off'}>{serviceOk ? '正常' : '已停止'}</b>
                </div>
                <div className="diag-cell">
                  <span>监听范围</span>
                  <b>{state.network.bindMode === 'all' ? '局域网' : '仅本机'}</b>
                </div>
                <div className="diag-cell">
                  <span>待审批</span>
                  <b>{state.pending.length} 条</b>
                </div>
                <div className="diag-cell">
                  <span>审批历史</span>
                  <b>{state.history.length} 条</b>
                </div>
              </div>
              <div className="row diag-actions">
                <button className="btn compact" onClick={() => void api.testNotify()}>
                  测试通知
                </button>
                <button className="btn compact" onClick={() => void api.testApproval()}>
                  测试审批弹窗
                </button>
                <button className="btn subtle compact" onClick={() => void api.openLogs()}>
                  日志目录
                </button>
                <button className="btn subtle compact" onClick={() => void api.openLogFile()}>
                  日志文件
                </button>
                <button
                  className={`btn ${serviceOk ? 'danger' : 'primary'} compact`}
                  onClick={() => void api.toggleServer()}
                >
                  {serviceOk ? '停止服务' : '启动服务'}
                </button>
              </div>
              <div className="card-footnote">
                <span>主题、字体、规则、自动更新等低频设置都在设置面板。</span>
                <button className="link" onClick={() => onOpenSettings('general')}>
                  全部设置
                </button>
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  )
}
