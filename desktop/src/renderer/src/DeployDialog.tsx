import { useEffect, useRef, useState } from 'react'
import type {
  AppState,
  DeployFormConfig,
  DeployResult,
  DeployTestResult,
  LogLevel,
  SecurityInfo
} from '../../shared/types'
import { api } from './api'
import { formatRelative } from './format'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  state: AppState
  onClose: () => void
}

const SHELLS = [
  { id: 'bash', label: 'Bash' },
  { id: 'zsh', label: 'Zsh' },
  { id: 'csh', label: 'Csh/Tcsh' },
  { id: 'fish', label: 'Fish' }
]

const EMPTY_FORM: DeployFormConfig = {
  mode: 'popup',
  host: '',
  sshPort: 22,
  username: '',
  authMethod: 'password',
  password: '',
  keyPath: '',
  keyPassphrase: '',
  callbackIp: '',
  callbackPort: 18765,
  hookTimeout: 300,
  toolMatcher: '',
  origin: '',
  rememberPassword: false,
  envImport: false,
  envShells: ['bash'],
  hostFingerprint: ''
}

interface LogLine {
  level: LogLevel
  message: string
}

export default function DeployDialog({ open, state, onClose }: Props): React.JSX.Element | null {
  const [form, setForm] = useState<DeployFormConfig>({
    ...EMPTY_FORM,
    callbackIp: state.server.localIp,
    callbackPort: state.network.port
  })
  const [security, setSecurity] = useState<SecurityInfo>({ available: false, label: '安全存储' })
  const [logs, setLogs] = useState<LogLine[]>([])
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [testing, setTesting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [result, setResult] = useState<DeployResult | null>(null)
  const [testResult, setTestResult] = useState<DeployTestResult | null>(null)
  const initialized = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)

  useFocusTrap(open, dialogRef, () => {
    if (!running && !testing && !removing) onClose()
  })

  useEffect(() => {
    if (!open) {
      initialized.current = false
      return
    }
    if (initialized.current) return
    initialized.current = true
    setLogs([])
    setError('')
    setResult(null)
    setTestResult(null)
    setConfirmRemove(false)
    setConfirmRestore(false)
    setForm({
      ...EMPTY_FORM,
      callbackIp: state.server.localIp,
      callbackPort: state.network.port,
      mode: state.prefs.mode
    })
    void api.getSecurityInfo().then(setSecurity)
    void api.getDeployCache().then((cache) => {
      setForm((current) => ({
        ...current,
        ...Object.fromEntries(
          Object.entries(cache).filter(
            ([, value]) => value !== undefined && value !== null && value !== ''
          )
        ),
        password: cache.password || '',
        callbackIp: cache.callbackIp || current.callbackIp || state.server.localIp,
        callbackPort: cache.callbackPort || current.callbackPort || state.network.port,
        origin: cache.origin || cache.host || ''
      }))
    })
    const off = api.onDeployProgress((progress) => {
      setLogs((current) => [...current, progress])
      setError('')
    })
    return off
  }, [open, state.server.localIp, state.network.port, state.prefs.mode])

  if (!open) return null

  const update = <K extends keyof DeployFormConfig>(key: K, value: DeployFormConfig[K]): void => {
    if (
      key === 'host' ||
      key === 'sshPort' ||
      key === 'username' ||
      key === 'authMethod' ||
      key === 'callbackIp' ||
      key === 'callbackPort'
    ) {
      setTestResult(null)
    }
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === 'host' || key === 'sshPort' ? { hostFingerprint: '' } : {})
    }))
  }

  const toggleShell = (id: string): void => {
    setForm((current) => ({
      ...current,
      envShells: current.envShells.includes(id)
        ? current.envShells.filter((shell) => shell !== id)
        : [...current.envShells, id]
    }))
  }

  const pickKey = async (): Promise<void> => {
    const path = await api.pickKeyFile()
    if (path) update('keyPath', path)
  }

  const validate = (): string => {
    if (!form.host.trim()) return '请填写服务器地址'
    if (!form.username.trim()) return '请填写用户名'
    if (!Number.isFinite(Number(form.sshPort)) || !Number.isFinite(Number(form.callbackPort))) {
      return '端口必须是数字'
    }
    if (Number(form.sshPort) < 1 || Number(form.sshPort) > 65535) return 'SSH 端口无效'
    if (Number(form.callbackPort) < 1024 || Number(form.callbackPort) > 65535) {
      return '回调端口需在 1024–65535 之间'
    }
    if (Number(form.hookTimeout) < 70) return '钩子超时建议不小于 70 秒'
    if (!form.callbackIp.trim()) return '请填写回调 IP'
    if (form.authMethod === 'password' && !form.password) return '请输入 SSH 密码'
    if (form.authMethod === 'key' && !form.keyPath?.trim()) return '请选择私钥文件'
    return ''
  }

  const normalized = (): DeployFormConfig => ({
    ...form,
    host: form.host.trim(),
    username: form.username.trim(),
    sshPort: Number(form.sshPort),
    callbackIp: form.callbackIp.trim(),
    callbackPort: Number(form.callbackPort),
    hookTimeout: Number(form.hookTimeout),
    toolMatcher: form.toolMatcher?.trim() || '',
    origin: form.origin?.trim() || form.host.trim(),
    envShells: form.envImport ? form.envShells : []
  })

  const testConnection = async (override?: Partial<DeployFormConfig>): Promise<void> => {
    const message = validate()
    if (message) {
      setError(message)
      return
    }
    setTesting(true)
    setError('')
    try {
      const response = await api.testDeploy({ ...normalized(), ...override })
      setTestResult(response)
      setLogs((current) => [
        ...current,
        { level: response.ok ? 'notify' : 'error', message: `连接测试：${response.message}` }
      ])
      if (response.connectivityMessage) {
        setLogs((current) => [
          ...current,
          {
            level: response.connectivity ? 'info' : 'warn',
            message: `回调预检：${response.connectivityMessage}`
          }
        ])
      }
      if (!response.ok) setError(response.message)
      else if (response.home) {
        setLogs((current) => [...current, { level: 'info', message: `服务器 HOME=${response.home}` }])
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setTesting(false)
    }
  }

  const trustFingerprint = async (): Promise<void> => {
    const fingerprint = testResult?.fingerprint
    if (!fingerprint) return
    update('hostFingerprint', fingerprint)
    await testConnection({ hostFingerprint: fingerprint })
  }

  const start = async (): Promise<void> => {
    const message = validate()
    if (message) {
      setError(message)
      return
    }
    if (!testResult?.ok && !form.hostFingerprint) {
      setError('请先“测试连接”并确认主机指纹，再执行部署')
      return
    }
    setRunning(true)
    setError('')
    setResult(null)
    setLogs([])
    try {
      const response = await api.startDeploy(normalized())
      setResult(response)
      if (!response.success) setError(response.summary)
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught)
      setError(text)
      setResult({ success: false, summary: text, connectivity: false })
    } finally {
      setRunning(false)
      setCancelling(false)
    }
  }

  const remove = async (): Promise<void> => {
    const message = validate()
    if (message) {
      setError(message)
      return
    }
    if (!testResult?.ok && !form.hostFingerprint) {
      setError('请先测试连接并确认主机指纹')
      return
    }
    setRemoving(true)
    setError('')
    setResult(null)
    setLogs([])
    try {
      const response = await api.removeDeploy(normalized())
      setResult(response)
      if (!response.success) setError(response.summary)
      else setConfirmRemove(false)
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught)
      setError(text)
    } finally {
      setRemoving(false)
      setCancelling(false)
    }
  }

  const restore = async (): Promise<void> => {
    const message = validate()
    if (message) {
      setError(message)
      return
    }
    if (!testResult?.ok && !form.hostFingerprint) {
      setError('请先测试连接并确认主机指纹')
      return
    }
    setRemoving(true)
    setError('')
    setResult(null)
    setLogs([])
    try {
      const response = await api.restoreDeploy(normalized())
      setResult(response)
      if (!response.success) setError(response.summary)
      else setConfirmRestore(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRemoving(false)
      setCancelling(false)
    }
  }

  const cancelDeploy = async (): Promise<void> => {
    if (cancelling) return
    if (!api.cancelDeploy) {
      setError('当前环境不支持取消部署')
      return
    }
    setCancelling(true)
    try {
      const response = await api.cancelDeploy()
      if (!response.ok) {
        setCancelling(false)
        if (response.message) {
          setLogs((current) => [...current, { level: 'warn', message: response.message as string }])
        }
        return
      }
      setLogs((current) => [
        ...current,
        { level: 'warn', message: response.message || '正在取消…' }
      ])
    } catch (caught) {
      setCancelling(false)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const profiles = state.deploy.profiles

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="deploy-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deploy-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div>
            <div className="modal-kicker">服务器接入</div>
            <h2 id="deploy-title">部署审批服务到服务器</h2>
            <p>通过 SSH 写入钩子、合并 settings.json，并从服务器反向验证本机连通性。</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭" disabled={running || removing}>
            ×
          </button>
        </header>

        <div className="deploy-modal-body">
          {profiles.length > 0 ? (
            <div className="form-section">
              <div className="form-section-title">最近目标</div>
              <div className="profile-list">
                {profiles.slice(0, 5).map((profile) => (
                  <button
                    className="profile-row"
                    key={profile.id}
                    onClick={() => {
                      setForm((current) => ({
                        ...current,
                        host: profile.host,
                        sshPort: profile.sshPort,
                        username: profile.username,
                        authMethod: profile.authMethod,
                        mode: profile.mode,
                        callbackIp: profile.callbackIp,
                        callbackPort: profile.callbackPort,
                        hookTimeout: profile.hookTimeout,
                        toolMatcher: profile.toolMatcher,
                        origin: profile.origin
                      }))
                      setTestResult(null)
                      setError('')
                    }}
                  >
                    <span className={`deploy-dot ${profile.status === 'deployed' ? 'ok' : 'idle'}`} />
                    <b>{profile.origin || profile.name}</b>
                    <span>
                      {profile.username}@{profile.host}:{profile.sshPort}
                    </span>
                    <em>{profile.mode === 'popup' ? '弹窗' : '通知'}</em>
                    <time>
                      {profile.lastDeployAt ? formatRelative(profile.lastDeployAt) : '未部署'}
                    </time>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="form-section">
            <div className="form-section-title">连接</div>
            <div className="segment-row">
              <button
                className={form.mode === 'popup' ? 'active' : ''}
                onClick={() => update('mode', 'popup')}
              >
                置顶弹窗 · 快速审批
              </button>
              <button
                className={form.mode === 'notify' ? 'active' : ''}
                onClick={() => update('mode', 'notify')}
              >
                系统通知 · 仅提醒
              </button>
            </div>
            <div className="form-grid two">
              <label className="field">
                <span>服务器地址</span>
                <input
                  value={form.host}
                  placeholder="192.168.1.20 或 dev.example.com"
                  onChange={(event) => update('host', event.target.value)}
                />
              </label>
              <label className="field">
                <span>SSH 端口</span>
                <input
                  type="number"
                  value={form.sshPort}
                  onChange={(event) => update('sshPort', Number(event.target.value))}
                />
              </label>
              <label className="field">
                <span>用户名</span>
                <input
                  value={form.username}
                  placeholder="SSH 登录用户名"
                  onChange={(event) => update('username', event.target.value)}
                />
              </label>
              <label className="field">
                <span>来源标签</span>
                <input
                  value={form.origin || ''}
                  placeholder="显示在弹窗上，如 prod-api"
                  onChange={(event) => update('origin', event.target.value)}
                />
              </label>
            </div>

            <div className="segment-row">
              <button
                className={form.authMethod === 'password' ? 'active' : ''}
                onClick={() => update('authMethod', 'password')}
              >
                密码认证
              </button>
              <button
                className={form.authMethod === 'key' ? 'active' : ''}
                onClick={() => update('authMethod', 'key')}
              >
                私钥认证
              </button>
            </div>

            {form.authMethod === 'password' ? (
              <div className="form-grid">
                <label className="field">
                  <span>SSH 密码</span>
                  <input
                    type="password"
                    value={form.password || ''}
                    onChange={(event) => update('password', event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <div className="form-grid">
                <label className="field wide">
                  <span>私钥文件</span>
                  <div className="input-row">
                    <input
                      value={form.keyPath || ''}
                      placeholder="~/.ssh/id_ed25519"
                      onChange={(event) => update('keyPath', event.target.value)}
                    />
                    <button className="btn" onClick={() => void pickKey()}>
                      浏览…
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>私钥密码（可选）</span>
                  <input
                    type="password"
                    value={form.keyPassphrase || ''}
                    onChange={(event) => update('keyPassphrase', event.target.value)}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="form-section">
            <div className="form-section-title">回调与审批</div>
            <div className="form-grid two">
              <label className="field">
                <span>回调 IP</span>
                <input
                  value={form.callbackIp}
                  list="callback-ips"
                  onChange={(event) => update('callbackIp', event.target.value)}
                />
                <datalist id="callback-ips">
                  {state.network.addresses.map((address) => (
                    <option key={address.address} value={address.address}>
                      {address.iface}
                    </option>
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span>回调端口</span>
                <input
                  type="number"
                  value={form.callbackPort}
                  onChange={(event) => update('callbackPort', Number(event.target.value))}
                />
              </label>
              <label className="field">
                <span>钩子超时（秒）</span>
                <input
                  type="number"
                  value={form.hookTimeout}
                  onChange={(event) => update('hookTimeout', Number(event.target.value))}
                />
              </label>
              <label className="field">
                <span>工具匹配（可选）</span>
                <input
                  value={form.toolMatcher || ''}
                  placeholder="留空 = 全部，如 Bash,Edit"
                  onChange={(event) => update('toolMatcher', event.target.value)}
                />
              </label>
            </div>
            <div className="form-note">
              审批等待时间自动取钩子超时减 60 秒。倒计时暂停会额外占用最多 600 秒钩子预算；多会话建议把钩子超时调到 600 秒，给队列留出余量。
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">选项</div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.rememberPassword}
                disabled={form.authMethod !== 'password' || !security.available}
                onChange={(event) => update('rememberPassword', event.target.checked)}
              />
              <span>
                记住密码（{security.label}）
                {!security.available ? ' · 当前平台不可用' : ''}
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.envImport}
                onChange={(event) => update('envImport', event.target.checked)}
              />
              <span>将 Token 写入服务器 Shell 环境变量</span>
            </label>
            {form.envImport ? (
              <div className="shell-chips">
                {SHELLS.map((shell) => (
                  <button
                    key={shell.id}
                    className={form.envShells.includes(shell.id) ? 'chip active' : 'chip'}
                    onClick={() => toggleShell(shell.id)}
                  >
                    {shell.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {testResult ? (
            <div className={`preflight ${testResult.ok ? 'ok' : 'fail'}`}>
              <div>
                <b>{testResult.ok ? 'SSH 预检通过' : '预检未通过'}</b>
                <span>{testResult.message}</span>
              </div>
              {testResult.fingerprint ? (
                <div className="fingerprint-row">
                  <span>主机指纹</span>
                  <code>{testResult.fingerprint}</code>
                  {!testResult.ok && testResult.code === 'HOST_KEY_UNKNOWN' ? (
                    <button className="btn compact" onClick={() => void trustFingerprint()}>
                      信任并重试
                    </button>
                  ) : null}
                  {testResult.code === 'HOST_KEY_MISMATCH' ? (
                    <span className="fingerprint-warning">指纹与已记录的不一致，请检查服务器是否被更换或遭到中间人攻击。</span>
                  ) : null}
                </div>
              ) : null}
              {testResult.ok ? (
                <div className={`preflight-line ${testResult.connectivity ? 'ok' : 'warn'}`}>
                  回调连通性：{testResult.connectivity ? '通过' : '未通过'}
                  {testResult.connectivityMessage ? ` · ${testResult.connectivityMessage}` : ''}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="form-section maintenance-row">
            <div className="form-section-title">维护</div>
            <div className="row">
              <button
                className="btn subtle"
                onClick={() => setConfirmRestore(true)}
                disabled={running || testing || removing}
              >
                恢复服务器上一个备份
              </button>
              <button
                className="btn danger"
                onClick={() => setConfirmRemove(true)}
                disabled={running || testing || removing}
              >
                移除服务器钩子
              </button>
            </div>
            <div className="form-note">
              恢复会先给当前 settings.json 另存一份 .pre-restore 备份；移除只清理本工具的钩子，保留第三方配置。
            </div>
          </div>

          {logs.length > 0 ? (
            <div className="deploy-log">
              {logs.map((line, index) => (
                <div className={`deploy-log-line level-${line.level}`} key={index}>
                  <span>{line.level.toUpperCase()}</span>
                  {line.message}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {error ? <div className="form-error modal-status">{error}</div> : null}
        {result?.success ? (
          <div className="form-success modal-status">
            {result.summary}
            {result.connectivity ? ' · 连通性通过' : ' · 连通性未通过'}
          </div>
        ) : null}

        <footer className="modal-actions">
          <button className="btn" onClick={onClose} disabled={running || testing || removing}>
            {result?.success ? '完成' : '取消'}
          </button>
          {confirmRemove ? (
            <>
              <button className="btn danger" onClick={() => void remove()} disabled={removing}>
                {removing ? '移除中…' : '确认移除服务器钩子'}
              </button>
              <button
                className="btn subtle"
                onClick={() => setConfirmRemove(false)}
                disabled={removing}
              >
                取消
              </button>
            </>
          ) : confirmRestore ? (
            <>
              <button className="btn primary" onClick={() => void restore()} disabled={removing}>
                {removing ? '恢复中…' : '确认恢复上一个备份'}
              </button>
              <button
                className="btn subtle"
                onClick={() => setConfirmRestore(false)}
                disabled={removing}
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => void testConnection()} disabled={running || testing}>
                {testing ? '连接中…' : '测试连接'}
              </button>
              <button
                className="btn primary"
                onClick={() => void start()}
                disabled={running || testing || removing || (!testResult?.ok && !form.hostFingerprint)}
                title={!testResult?.ok && !form.hostFingerprint ? '请先测试连接并确认主机指纹' : undefined}
              >
                {running ? '部署中…' : '部署并验证'}
              </button>
            </>
          )}
          {running || removing ? (
            <button
              className="btn danger"
              onClick={() => void cancelDeploy()}
              disabled={cancelling}
            >
              {cancelling ? '正在取消…' : '取消部署'}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  )
}
