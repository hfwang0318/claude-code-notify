import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, PopupPosition } from '../../shared/types'
import { api } from './api'
import DeployDialog from './DeployDialog'
import { formatTime, LEVEL_LABEL, maskToken } from './format'

const POSITIONS: Array<{ id: PopupPosition; label: string }> = [
  { id: 'primary', label: '主屏幕' },
  { id: 'cursor', label: '跟随鼠标' },
  { id: 'focus', label: '焦点窗口' }
]

function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    let alive = true
    void api.getState().then((next) => {
      if (alive) setState(next)
    })
    const off = api.onState((next) => setState(next))
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}

export default function App(): React.JSX.Element {
  const state = useAppState()
  const [showToken, setShowToken] = useState(false)
  const [deployOpen, setDeployOpen] = useState(false)
  const [localMode, setLocalMode] = useState<'popup' | 'notify' | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = logRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [state?.logs.length])

  useEffect(() => {
    void api.localStatus().then((status) => setLocalMode(status.mode))
  }, [])

  const connectLocal = async (): Promise<void> => {
    if (!state) return
    const response = await api.localDeploy(state.prefs.mode)
    if (response.ok) setLocalMode(state.prefs.mode)
  }

  const address = useMemo(() => {
    if (!state) return ''
    return `http://${state.server.localIp}:${state.server.port}`
  }, [state])

  if (!state) {
    return <div className="boot">正在启动本地中继…</div>
  }

  const isMac = state.app.platform === 'darwin'
  const pending = state.pending.length
  const deployed = state.deploy.status === 'deployed'
  const deployRunning = state.deploy.status === 'running'
  const serviceOk = state.server.listening

  const copyToken = (): void => void api.copy(state.server.token)
  const copyConnectCommand = (): void =>
    void api.copy(
      `curl -X POST ${address}/claude-notify \\\n  -H "Authorization: Bearer ${state.server.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"message":"hello"}'`
    )

  return (
    <div className="shell" data-platform={isMac ? 'darwin' : state.app.platform}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <div className="brand-name">Claude Notify</div>
            <div className="brand-sub">LOCAL RELAY · {state.server.port}</div>
          </div>
        </div>
        <div className="titlebar-actions">
          <span className={`status-pill ${serviceOk ? 'on' : 'off'}`}>
            <i aria-hidden="true" />
            {serviceOk ? 'LISTENING' : 'STOPPED'}
          </span>
          <button className="btn ghost compact" onClick={() => void api.toggleServer()}>
            {serviceOk ? '暂停' : '启动'}
          </button>
          <button className="btn ghost compact" onClick={() => void api.hideWindow()}>
            隐藏到托盘
          </button>
        </div>
      </header>

      <div className="statusbar" role="group" aria-label="核心状态">
        <div className="status-cell">
          <span className="status-key">服务</span>
          <span className={`status-value ${serviceOk ? 'ok' : 'muted'}`}>
            {serviceOk ? 'HTTP · OK' : 'HTTP · STOPPED'}
          </span>
        </div>
        <div className="status-cell">
          <span className="status-key">待审批</span>
          <span className={`status-value ${pending > 0 ? 'alert' : ''}`}>{pending}</span>
        </div>
        <div className="status-cell">
          <span className="status-key">服务器</span>
          <span className="status-value info">
            {deployed ? `已部署 · ${state.deploy.hooks} hooks` : '尚未部署'}
          </span>
        </div>
      </div>

      <main className="content">
        <aside className="column left">
          <section className="card">
            <header className="card-head">
              <span className="card-index">01</span>
              <span className="card-title">连接与凭证</span>
              <span className="card-hint">Bearer</span>
            </header>
            <dl className="kv">
              <dt>服务地址</dt>
              <dd title={address}>{address}</dd>
              <dt>本机 IP</dt>
              <dd>{state.server.localIp}</dd>
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
          </section>

          <section className="card">
            <header className="card-head">
              <span className="card-index">02</span>
              <span className="card-title">偏好</span>
              <span className="card-hint">立即生效</span>
            </header>
            <div className="segmented" role="group" aria-label="弹窗位置">
              {POSITIONS.map((position) => {
                const disabled = position.id === 'focus' && state.app.platform !== 'win32'
                return (
                  <button
                    key={position.id}
                    className={state.prefs.position === position.id ? 'active' : ''}
                    disabled={disabled}
                    title={disabled ? '仅 Windows 支持焦点窗口定位' : undefined}
                    onClick={() => void api.setPosition(position.id)}
                  >
                    {position.label}
                  </button>
                )
              })}
            </div>
            <div className="pref-line">
              <span>本机模式</span>
              <div className="mini-seg" role="group" aria-label="本机接入模式">
                <button
                  className={state.prefs.mode === 'popup' ? 'active' : ''}
                  onClick={() => void api.setMode('popup')}
                >
                  弹窗
                </button>
                <button
                  className={state.prefs.mode === 'notify' ? 'active' : ''}
                  onClick={() => void api.setMode('notify')}
                >
                  通知
                </button>
              </div>
            </div>
            <div className="pref-line">
              <span>超时回退</span>
              <span className="pref-value">{state.prefs.timeoutSec} 秒 · 交给终端</span>
            </div>
            <div className="pref-line">
              <span>关闭窗口</span>
              <span className="pref-value">最小化到托盘</span>
            </div>
          </section>

          <div className="keyboard-card">
            <div className="keyboard-title">键盘</div>
            <div className="keyboard-row">
              <kbd>Enter</kbd>
              <span>允许</span>
              <kbd>Esc</kbd>
              <span>交给终端</span>
            </div>
            <p>审批弹窗始终置顶并跟随当前桌面；超时或网络失败都会自动回退终端，不会卡住 Claude Code。</p>
          </div>
        </aside>

        <section className="column right">
          <section className="card deploy-card">
            <header className="card-head">
              <span className="card-index">03</span>
              <span className="card-title">部署</span>
              <span className="card-hint">低频操作</span>
            </header>
            <div className="deploy-body">
              <div className="deploy-status">
                <span
                  className={`deploy-dot ${
                    deployRunning ? 'running' : deployed ? 'ok' : 'idle'
                  }`}
                  aria-hidden="true"
                />
                <div className="deploy-copy">
                  <div className="deploy-host">
                    {state.deploy.host || 'deploy@192.168.1.20:22'}
                    <span className="deploy-mode">key + 安全存储</span>
                  </div>
                  <div className="deploy-sub">
                    {deployRunning ? state.deploy.message : state.deploy.message}
                  </div>
                </div>
              </div>
              <div className="deploy-actions">
                <button
                  className="btn compact"
                  title={localMode ? '本机已接入，点击重新写入' : '写入本机 ~/.claude'}
                  onClick={() => void connectLocal()}
                >
                  {localMode ? `本机已接入 · ${localMode === 'popup' ? '弹窗' : '通知'}` : '接入本机'}
                </button>
                <button className="btn" onClick={() => void api.copy(address)}>
                  复制地址
                </button>
                <button
                  className="btn primary"
                  disabled={deployRunning}
                  onClick={() => setDeployOpen(true)}
                >
                  {deployRunning ? '部署中…' : '部署并验证'}
                </button>
              </div>
            </div>
          </section>

          <section className="card log-card">
            <header className="card-head">
              <span className="card-index">04</span>
              <span className="card-title">实时日志</span>
              <span className="card-hint">{state.logs.length} / 500</span>
            </header>
            <div className="log-body" ref={logRef} role="log" aria-live="polite">
              {state.logs.length === 0 ? (
                <div className="log-empty">暂无日志。启动服务或推送一条通知。</div>
              ) : (
                state.logs.map((entry) => (
                  <div className={`log-line level-${entry.level}`} key={entry.id}>
                    <span className="log-time">{formatTime(entry.ts)}</span>
                    <span className="log-level">{LEVEL_LABEL[entry.level] ?? entry.level}</span>
                    <span className="log-message">{entry.text}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          <footer className="actions">
            <button className="btn" onClick={() => void api.testNotify()}>
              测试通知
            </button>
            <button className="btn" onClick={() => void api.testApproval()}>
              测试审批弹窗
            </button>
            <button className="btn subtle" onClick={() => void api.openLogs()}>
              打开日志目录
            </button>
            <button className="btn danger" onClick={() => void api.toggleServer()}>
              {serviceOk ? '停止服务' : '启动服务'}
            </button>
            <span className="actions-hint">Enter=允许 · Esc=交给终端</span>
          </footer>
        </section>
      </main>

      <DeployDialog
        open={deployOpen}
        localIp={state.server.localIp}
        port={state.server.port}
        onClose={() => setDeployOpen(false)}
      />

      {state.toast ? <div className="toast">{state.toast}</div> : null}
    </div>
  )
}
