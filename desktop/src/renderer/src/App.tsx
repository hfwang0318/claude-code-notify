import { useEffect, useMemo, useState } from 'react'
import type { AppState, PopupPosition } from '../../shared/types'
import { api } from './api'
import DeployDialog from './DeployDialog'
import HistoryPanel from './HistoryPanel'
import Inbox from './Inbox'
import LogPanel from './LogPanel'
import Preferences, { type SettingsSection } from './Preferences'
import { maskToken } from './format'

const POSITIONS: Array<{ id: PopupPosition; label: string }> = [
  { id: 'primary', label: '主屏幕' },
  { id: 'cursor', label: '跟随鼠标' },
  { id: 'focus', label: '焦点窗口' }
]

type Tab = 'inbox' | 'history' | 'logs'

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

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

export default function App(): React.JSX.Element {
  const state = useAppState()
  const now = useNow()
  const [showToken, setShowToken] = useState(false)
  const [deployOpen, setDeployOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [tab, setTab] = useState<Tab>('inbox')
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [localMode, setLocalMode] = useState<'popup' | 'notify' | null>(null)
  const [localBusy, setLocalBusy] = useState(false)

  useEffect(() => {
    const offCommand = api.onUiCommand((command) => {
      if (command === 'prefs') {
        setSettingsSection('general')
        setSettingsOpen(true)
      } else if (command === 'about') {
        setSettingsSection('about')
        setSettingsOpen(true)
      } else {
        setTab('inbox')
      }
    })
    const offFocus = api.onFocusSession((key) => {
      setTab('inbox')
      setFocusKey(key)
    })
    return () => {
      offCommand()
      offFocus()
    }
  }, [])

  useEffect(() => {
    let alive = true
    void api.localStatus().then((status) => {
      if (alive) setLocalMode(status.mode)
    })
    return () => {
      alive = false
    }
  }, [state?.deploy.localMode])

  const connectLocal = async (): Promise<void> => {
    if (!state) return
    setLocalBusy(true)
    const response = await api.localDeploy(state.prefs.mode)
    setLocalBusy(false)
    if (response.ok) {
      setLocalMode(state.prefs.mode)
      if (!state.onboarding.done) void api.finishOnboarding()
    }
  }

  const applyMode = async (): Promise<void> => {
    if (!state) return
    if (state.deploy.localMode) {
      await connectLocal()
      return
    }
    setDeployOpen(true)
  }

  const openSettings = (section: SettingsSection = 'general'): void => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }

  const address = state
    ? `http://${state.server.localIp}:${state.server.port}`
    : ''

  const waitingSessions = useMemo(
    () => new Set(state?.pending.map((item) => item.sessionKey) || []).size,
    [state?.pending]
  )

  if (!state) {
    return <div className="boot">正在启动本地中继…</div>
  }

  const isMac = state.app.platform === 'darwin'
  const pending = state.pending.length
  const serviceOk = state.server.listening
  const deployed = Boolean(state.deploy.localMode) || state.deploy.profiles.length > 0
  const deployRunning = state.deploy.status === 'running'
  const latestProfile = state.deploy.profiles.find((profile) => profile.status === 'deployed')
  const serverSummary = state.deploy.localMode
    ? `本机 · ${state.deploy.localMode === 'popup' ? '弹窗' : '通知'}`
    : latestProfile
      ? `${latestProfile.origin || latestProfile.host} · ${latestProfile.hooks} hooks`
      : '尚未部署'
  const modeLabel = state.prefs.mode === 'popup' ? '弹窗' : '通知'

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
            <div className="brand-sub">
              本机中继 · {state.server.port} · v{state.app.version}
            </div>
          </div>
        </div>
        <div className="titlebar-actions">
          <span className={`status-pill ${serviceOk ? 'on' : 'off'}`}>
            <i aria-hidden="true" />
            {serviceOk ? '监听中' : '已停止'}
          </span>
          {pending > 0 ? (
            <button className="pending-pill" onClick={() => setTab('inbox')}>
              {pending} 条待审批
            </button>
          ) : null}
          <button className="btn ghost compact" onClick={() => openSettings()}>
            设置
          </button>
          <button className="btn ghost compact" onClick={() => void api.hideWindow()}>
            隐藏到托盘
          </button>
        </div>
      </header>

      <div className="statusbar" role="group" aria-label="核心状态">
        <button className="status-cell as-button" onClick={() => openSettings('network')}>
          <span className="status-key">服务</span>
          <span className={`status-value ${serviceOk ? 'ok' : 'muted'}`}>
            {serviceOk ? 'HTTP · 正常' : 'HTTP · 已停止'}
          </span>
          <span className="status-sub">
            {state.network.bindMode === 'all' ? '局域网' : '仅本机'} · {state.server.port}
          </span>
        </button>
        <button className="status-cell as-button" onClick={() => setTab('inbox')}>
          <span className="status-key">待审批</span>
          <span className={`status-value ${pending > 0 ? 'alert' : ''}`}>{pending}</span>
          <span className="status-sub">{waitingSessions} 个会话</span>
        </button>
        <button className="status-cell as-button" onClick={() => (deployed ? setDeployOpen(true) : setDeployOpen(true))}>
          <span className="status-key">接入</span>
          <span className="status-value info">{serverSummary}</span>
          <span className="status-sub">
            {state.deploy.hookStale
              ? '钩子版本需更新'
              : state.deploy.modeMismatch
                ? '模式需重新应用'
                : state.deploy.message}
          </span>
        </button>
      </div>

      {state.network.error ? (
        <div className="banner error">
          <div>
            <b>{state.network.conflict ? '端口被占用' : '服务异常'}</b>
            <span>{state.network.error}</span>
          </div>
          <button className="btn compact" onClick={() => openSettings('network')}>
            处理
          </button>
        </div>
      ) : null}

      {state.deploy.hookStale ? (
        <div className="banner warn">
          <div>
            <b>本机 Hook 需要更新</b>
            <span>旧版 Hook 不会跳过 bypass 审批，Bash 和文件工具可能误弹窗。</span>
          </div>
          <button className="btn compact" disabled={localBusy} onClick={() => void connectLocal()}>
            {localBusy ? '更新中…' : '立即更新'}
          </button>
        </div>
      ) : null}

      {!state.onboarding.done ? (
        <section className="onboarding">
          <div className="onboarding-head">
            <div>
              <b>3 步开始</b>
              <span>接入 Claude Code → 写入钩子 → 发一条测试审批</span>
            </div>
            <button className="link" onClick={() => void api.finishOnboarding()}>
              跳过引导
            </button>
          </div>
          <div className="onboarding-steps">
            <div className="onboarding-step">
              <em>01</em>
              <div>
                <b>选择接入方式</b>
                <span>本机零配置；远程服务器需要 SSH。</span>
              </div>
            </div>
            <div className="onboarding-step">
              <em>02</em>
              <div>
                <b>写入钩子</b>
                <span>自动备份并保留第三方 hooks。</span>
              </div>
            </div>
            <div className="onboarding-step">
              <em>03</em>
              <div>
                <b>验证弹窗</b>
                <span>发一条测试审批，确认能弹出来。</span>
              </div>
            </div>
          </div>
          <div className="onboarding-actions">
            <button
              className="btn primary compact"
              disabled={localBusy}
              onClick={() => void connectLocal()}
            >
              {localBusy ? '接入中…' : '接入本机'}
            </button>
            <button className="btn compact" onClick={() => setDeployOpen(true)}>
              部署到服务器
            </button>
            <button
              className="btn subtle compact"
              onClick={() => {
                void api.finishOnboarding()
                void api.testApproval()
              }}
            >
              发送测试审批
            </button>
          </div>
        </section>
      ) : null}

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
              <button className="link" onClick={() => openSettings('network')}>
                网络设置
              </button>
            </div>
          </section>

          <section className="card">
            <header className="card-head">
              <span className="card-index">02</span>
              <span className="card-title">弹窗偏好</span>
              <span className="card-hint">立即生效</span>
            </header>
            <div className="pref-block">
              <span className="pref-label">位置</span>
              <div className="segmented" role="group" aria-label="弹窗位置">
                {POSITIONS.map((position) => {
                  const disabled = position.id === 'focus' && state.app.platform !== 'win32'
                  return (
                    <button
                      key={position.id}
                      className={state.prefs.position === position.id ? 'active' : ''}
                      disabled={disabled}
                      aria-pressed={state.prefs.position === position.id}
                      title={disabled ? '仅 Windows 支持焦点窗口定位' : undefined}
                      onClick={() => void api.setPrefs({ position: position.id })}
                    >
                      {position.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="pref-line">
              <span>本机模式</span>
              <div className="mini-seg" role="group" aria-label="本机接入模式">
                <button
                  className={state.prefs.mode === 'popup' ? 'active' : ''}
                  aria-pressed={state.prefs.mode === 'popup'}
                  onClick={() => void api.setPrefs({ mode: 'popup' })}
                >
                  弹窗
                </button>
                <button
                  className={state.prefs.mode === 'notify' ? 'active' : ''}
                  aria-pressed={state.prefs.mode === 'notify'}
                  onClick={() => void api.setPrefs({ mode: 'notify' })}
                >
                  通知
                </button>
              </div>
            </div>
            {state.deploy.modeMismatch ? (
              <div className="inline-warning">
                已部署钩子仍是旧模式
                <button className="link" onClick={() => void applyMode()}>
                  立即应用{modeLabel}
                </button>
              </div>
            ) : null}
            {state.deploy.hookStale ? (
              <div className="inline-warning">
                本机钩子版本 {state.deploy.hookVersion || '未知'} 需要更新
                <button className="link" onClick={() => void connectLocal()}>
                  重新接入
                </button>
              </div>
            ) : null}
            <div className="pref-line">
              <span>超时回退</span>
              <span className="pref-value">
                {state.prefs.timeoutSec} 秒 · 交给终端
                <button className="link" onClick={() => openSettings('general')}>
                  调整
                </button>
              </span>
            </div>
            <div className="card-footnote">
              <button className="link" onClick={() => openSettings('popup')}>
                全部弹窗设置
              </button>
              <span>弹窗可拖动，位置会被记住</span>
            </div>
          </section>

          <div className="keyboard-card">
            <div className="keyboard-title">键盘与多会话</div>
            <div className="keyboard-row">
              <kbd>Enter</kbd>
              <span>允许/提交</span>
              <kbd>Esc</kbd>
              <span>交给终端</span>
              <kbd>1–9</kbd>
              <span>选项</span>
            </div>
            <p>
              多个 Claude 会话会按剩余时间排序，并在弹窗顶部显示会话条；点会话条或收件箱即可切换。
              高风险命令需要二次确认，避免误批。
            </p>
          </div>
        </aside>

        <section className="column right">
          <section className="card deploy-card">
            <header className="card-head">
              <span className="card-index">03</span>
              <span className="card-title">接入与部署</span>
              <span className="card-hint">
                {deployRunning ? '运行中' : state.deploy.hookVersion ? `钩子 v${state.deploy.hookVersion}` : '未检测'}
              </span>
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
                    {state.deploy.localMode
                      ? '本机 · 127.0.0.1'
                      : latestProfile
                        ? `${latestProfile.username}@${latestProfile.host}:${latestProfile.sshPort}`
                        : '尚未连接 Claude Code'}
                    <span className="deploy-mode">
                      {state.deploy.localMode
                        ? state.deploy.localMode === 'popup'
                          ? '弹窗'
                          : '通知'
                        : latestProfile
                          ? latestProfile.mode === 'popup'
                            ? '弹窗'
                            : '通知'
                          : '未配置'}
                    </span>
                  </div>
                  <div className="deploy-sub">{state.deploy.message}</div>
                </div>
              </div>
              <div className="deploy-actions">
                <button
                  className="btn compact"
                  disabled={localBusy}
                  onClick={() => void connectLocal()}
                  title={localMode ? '本机已接入，点击重新写入' : '写入本机 ~/.claude'}
                >
                  {localBusy ? '接入中…' : localMode ? '重新接入本机' : '接入本机'}
                </button>
                {localMode ? (
                  <>
                    <button className="btn subtle compact" onClick={() => void api.removeLocal()}>
                      断开本机
                    </button>
                    <button className="btn subtle compact" onClick={() => void api.restoreLocal()}>
                      恢复备份
                    </button>
                  </>
                ) : null}
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
            {state.deploy.profiles.length > 0 ? (
              <div className="profile-strip">
                {state.deploy.profiles.slice(0, 4).map((profile) => (
                  <button
                    className="profile-chip"
                    key={profile.id}
                    title={`${profile.username}@${profile.host}:${profile.sshPort} · ${profile.mode === 'popup' ? '弹窗' : '通知'}`}
                    onClick={() => setDeployOpen(true)}
                  >
                    <i className={profile.status === 'deployed' ? 'ok' : 'idle'} aria-hidden="true" />
                    <span>{profile.origin || profile.name}</span>
                    <em>{profile.hooks} hooks</em>
                  </button>
                ))}
                {state.deploy.profiles.length > 4 ? (
                  <span className="profile-more">+{state.deploy.profiles.length - 4}</span>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="card log-card panel-card">
            <header className="card-head panel-head">
              <div className="tabs" role="tablist" aria-label="主面板">
                <button
                  role="tab"
                  aria-selected={tab === 'inbox'}
                  className={tab === 'inbox' ? 'active' : ''}
                  onClick={() => setTab('inbox')}
                >
                  待审批
                  {pending > 0 ? <b>{pending}</b> : null}
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'history'}
                  className={tab === 'history' ? 'active' : ''}
                  onClick={() => setTab('history')}
                >
                  历史
                  {state.history.length > 0 ? <b>{state.history.length}</b> : null}
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'logs'}
                  className={tab === 'logs' ? 'active' : ''}
                  onClick={() => setTab('logs')}
                >
                  日志
                  <b>{state.logs.length}</b>
                </button>
              </div>
              <span className="card-hint">
                {tab === 'inbox'
                  ? `${waitingSessions} 个会话`
                  : tab === 'history'
                    ? `${state.history.length} 条记录`
                    : `${state.logs.length} 行`}
              </span>
            </header>

            <div className="panel-body">
              {tab === 'inbox' ? (
                <Inbox
                  state={state}
                  now={now}
                  focusSessionKey={focusKey}
                  onClearFocus={() => setFocusKey(null)}
                  onOpenDeploy={() => setDeployOpen(true)}
                  onOpenHistory={() => setTab('history')}
                />
              ) : tab === 'history' ? (
                <HistoryPanel
                  history={state.history}
                  now={now}
                  onOpenInbox={() => setTab('inbox')}
                />
              ) : (
                <LogPanel logs={state.logs} />
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
            <button className="btn subtle" onClick={() => openSettings('about')}>
              关于
            </button>
            <button className="btn subtle" onClick={() => void api.openLogs()}>
              打开日志目录
            </button>
            <button
              className={`btn ${serviceOk ? 'danger' : 'primary'}`}
              onClick={() => void api.toggleServer()}
            >
              {serviceOk ? '停止服务' : '启动服务'}
            </button>
            <span className="actions-hint">
              会话 {state.sessions.filter((session) => session.state === 'waiting').length} 个等待中
            </span>
          </footer>
        </section>
      </main>

      <DeployDialog open={deployOpen} state={state} onClose={() => setDeployOpen(false)} />

      <Preferences
        open={settingsOpen}
        state={state}
        section={settingsSection}
        onSection={setSettingsSection}
        onClose={() => setSettingsOpen(false)}
      />

      {state.toast ? <div className="toast">{state.toast}</div> : null}
    </div>
  )
}
