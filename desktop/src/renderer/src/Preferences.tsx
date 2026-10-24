import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppState,
  BindMode,
  FontSize,
  FontStyle,
  Prefs,
  RuleScope,
  ThemeMode
} from '../../shared/types'
import { describeRule } from '../../shared/rules'
import { minutesUntilTomorrow } from './format'
import { api } from './api'
import { useFocusTrap } from './useFocusTrap'

export type SettingsSection = 'general' | 'popup' | 'network' | 'rules' | 'about'

interface Props {
  state: AppState
  open: boolean
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  onClose: () => void
}

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'popup', label: '提醒' },
  { id: 'network', label: '网络' },
  { id: 'rules', label: '规则' },
  { id: 'about', label: '关于' }
]

const THEMES: Array<{ id: ThemeMode; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' }
]

const FONT_STYLES: Array<{ id: FontStyle; label: string; hint: string }> = [
  { id: 'system', label: '系统', hint: '系统无衬线字体' },
  { id: 'rounded', label: '圆体', hint: '更柔和的圆角字形' },
  { id: 'serif', label: '衬线', hint: '宋体/衬线字体' },
  { id: 'mono', label: '等宽', hint: '类似终端的等宽字体' }
]

const FONT_SIZES: Array<{ id: FontSize; label: string; hint: string }> = [
  { id: 'small', label: '小', hint: '92%' },
  { id: 'normal', label: '标准', hint: '100%' },
  { id: 'large', label: '大', hint: '106%' },
  { id: 'xlarge', label: '特大', hint: '112%' }
]

const FOCUS_POLICIES = [
  { id: 'first', label: '首次弹窗时聚焦' },
  { id: 'always', label: '每条都聚焦' },
  { id: 'never', label: '从不抢焦点' }
]

const SCOPES: Array<{ id: RuleScope; label: string }> = [
  { id: 'session', label: '当前会话' },
  { id: 'project', label: '当前项目' },
  { id: 'global', label: '所有项目' }
]

function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}): React.JSX.Element {
  return (
    <label className="toggle-row">
      <span>
        <b>{label}</b>
        {hint ? <em>{hint}</em> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

export default function Preferences({
  state,
  open,
  section,
  onSection,
  onClose
}: Props): React.JSX.Element | null {
  const [port, setPort] = useState(String(state.prefs.port))
  const [bindMode, setBindMode] = useState<BindMode>(state.prefs.bindMode)
  const [timeout, setTimeoutValue] = useState(String(state.prefs.timeoutSec))
  const [maxPending, setMaxPending] = useState(String(state.prefs.maxPending))
  const [networkMessage, setNetworkMessage] = useState('')
  const [networkBusy, setNetworkBusy] = useState(false)
  const [ruleScope, setRuleScope] = useState<RuleScope>('project')
  const [ruleTool, setRuleTool] = useState('Bash')
  const [rulePattern, setRulePattern] = useState('')
  const [ruleProject, setRuleProject] = useState('')
  const [ruleSessionKey, setRuleSessionKey] = useState('')
  const [ruleOrigin, setRuleOrigin] = useState('')
  const [ruleExpiry, setRuleExpiry] = useState<'forever' | '1h' | '24h'>('forever')
  const [ruleMessage, setRuleMessage] = useState('')
  const dialogRef = useRef<HTMLElement>(null)

  useFocusTrap(open, dialogRef, onClose)

  useEffect(() => {
    if (!open) return
    setPort(String(state.prefs.port))
    setBindMode(state.prefs.bindMode)
    setTimeoutValue(String(state.prefs.timeoutSec))
    setMaxPending(String(state.prefs.maxPending))
    setNetworkMessage('')
    setRuleMessage('')
    setRuleSessionKey('')
    setRuleOrigin('')
    if (state.pending[0]) setRuleProject(state.pending[0].project)
  }, [open, state.prefs.port, state.prefs.bindMode, state.prefs.timeoutSec, state.prefs.maxPending])

  const previews = useMemo(() => state.sessions.slice(0, 8), [state.sessions])
  const waitingCount = state.sessions.filter((session) => session.state === 'waiting').length
  const waitingSessions = useMemo(
    () => state.sessions.filter((session) => session.waiting > 0),
    [state.sessions]
  )
  const ruleOrigins = useMemo(() => {
    const values = [
      ...state.sessions.map((session) => session.origin),
      ...state.pending.map((entry) => entry.origin)
    ]
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
  }, [state.sessions, state.pending])

  if (!open) return null

  const save = (patch: Partial<Prefs>): void => {
    void api.setPrefs(patch)
  }

  const applyNetwork = async (): Promise<void> => {
    setNetworkBusy(true)
    setNetworkMessage('')
    const result = await api.applyNetwork({
      port: Number(port),
      bindMode
    })
    setNetworkBusy(false)
    setNetworkMessage(result.message)
  }

  const addRule = async (): Promise<void> => {
    setRuleMessage('')
    const targetSession = waitingSessions.find((session) => session.key === ruleSessionKey)
    if (ruleScope === 'session' && !targetSession) {
      setRuleMessage(
        waitingSessions.length === 0
          ? '当前没有等待中的会话；请改用项目或全局作用域'
          : '请选择目标会话'
      )
      return
    }
    if (ruleScope === 'project' && !ruleProject.trim()) {
      setRuleMessage('请填写项目名')
      return
    }
    try {
      const expiresAt =
        ruleExpiry === '1h'
          ? Date.now() + 60 * 60 * 1000
          : ruleExpiry === '24h'
            ? Date.now() + 24 * 60 * 60 * 1000
            : undefined
      await api.addRule({
        scope: ruleScope,
        tool: ruleTool,
        pattern: rulePattern,
        project: ruleScope === 'project' ? ruleProject.trim() : undefined,
        sessionKey: ruleScope === 'session' ? targetSession?.key : undefined,
        origin: ruleScope === 'project' && ruleOrigin ? ruleOrigin : undefined,
        ...(expiresAt ? { expiresAt } : {})
      })
      setRulePattern('')
      setRuleMessage('规则已保存')
    } catch (error) {
      setRuleMessage((error as Error).message)
    }
  }

  const updateStatus =
    state.update.status === 'checking'
      ? '检查中…'
      : state.update.status === 'available'
        ? state.update.message || `发现 ${state.update.latest}`
        : state.update.status === 'downloading'
          ? `下载中 ${state.update.progress ?? 0}%`
          : state.update.status === 'downloaded'
            ? state.update.message ||
              (state.update.installable === false
                ? '更新包已下载，请退出应用后手动替换'
                : '更新已下载，重启后安装')
            : state.update.status === 'latest'
              ? state.update.message || '已是最新版本'
              : state.update.status === 'error'
                ? state.update.message || '检查失败'
                : ''

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="deploy-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <div className="modal-kicker">设置</div>
            <h2 id="settings-title">偏好与运行配置</h2>
            <p>修改会立即保存；端口、监听范围和超时会在需要重启时给出提示。</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </header>

        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={section === entry.id}
              className={section === entry.id ? 'active' : ''}
              onClick={() => onSection(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="deploy-modal-body settings-body">
          {section === 'general' ? (
            <>
              <div className="form-section">
                <div className="form-section-title">外观</div>
                <div className="segment-row">
                  {THEMES.map((theme) => (
                    <button
                      key={theme.id}
                      className={state.prefs.theme === theme.id ? 'active' : ''}
                      onClick={() => save({ theme: theme.id })}
                    >
                      {theme.label}
                    </button>
                  ))}
                </div>
                <div className="form-note">
                  深色与浅色会立即应用到主窗口和审批弹窗；跟随系统会响应系统外观变化。
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">字体</div>
                <div className="font-setting">
                  <span className="field-label">字体样式</span>
                  <div className="segment-row font-style-row">
                    {FONT_STYLES.map((font) => (
                      <button
                        key={font.id}
                        className={state.prefs.fontStyle === font.id ? 'active' : ''}
                        aria-pressed={state.prefs.fontStyle === font.id}
                        title={font.hint}
                        onClick={() => save({ fontStyle: font.id })}
                      >
                        {font.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="font-setting">
                  <span className="field-label">字体大小</span>
                  <div className="segment-row font-size-row">
                    {FONT_SIZES.map((size) => (
                      <button
                        key={size.id}
                        className={state.prefs.fontSize === size.id ? 'active' : ''}
                        aria-pressed={state.prefs.fontSize === size.id}
                        title={size.hint}
                        onClick={() => save({ fontSize: size.id })}
                      >
                        {size.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="font-preview" data-font-preview>
                  <div className="font-preview-kicker">预览</div>
                  <p>Claude 请求执行权限 · 允许 / 拒绝</p>
                  <code>Bash · git status</code>
                </div>
                <div className="form-note">
                  字体样式和大小会同时应用到主窗口、设置面板和审批弹窗；字号按比例缩放，不改变窗口尺寸。
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">通知</div>
                <Toggle
                  checked={state.prefs.sound}
                  onChange={(value) => save({ sound: value })}
                  label="审批到达时提示音"
                  hint="多个会话同时到达时只响一次，不重复打断"
                />
                <Toggle
                  checked={state.prefs.systemNotifications}
                  onChange={(value) => save({ systemNotifications: value })}
                  label="系统通知"
                  hint="聚合显示最近 1.2 秒内到达的会话；点击可跳转到对应会话"
                />
                <Toggle
                  checked={state.prefs.enterConfirmsHighRisk}
                  onChange={(value) => save({ enterConfirmsHighRisk: value })}
                  label="高风险操作二次确认"
                  hint="高风险命令需要再按一次 Enter，避免误批"
                />
                <Toggle
                  checked={state.prefs.admissionControl}
                  onChange={(value) => save({ admissionControl: value })}
                  label="队列准入控制"
                  hint="当排队时间可能超过剩余审批时间时，直接回退终端，避免“弹了却看不见”"
                />
                <Toggle
                  checked={state.prefs.quietHoursEnabled}
                  onChange={(value) => save({ quietHoursEnabled: value })}
                  label="免打扰时段"
                  hint="时段内只静默系统通知；高风险审批仍会提醒"
                />
                {state.prefs.quietHoursEnabled ? (
                  <div className="form-grid two quiet-hours">
                    <label className="field">
                      <span>开始</span>
                      <input
                        type="time"
                        value={state.prefs.quietHoursStart}
                        onChange={(event) => save({ quietHoursStart: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>结束</span>
                      <input
                        type="time"
                        value={state.prefs.quietHoursEnd}
                        onChange={(event) => save({ quietHoursEnd: event.target.value })}
                      />
                    </label>
                  </div>
                ) : null}
              </div>

              <div className="form-section">
                <div className="form-section-title">队列</div>
                <label className="field">
                  <span>最大等待审批数</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={maxPending}
                    onChange={(event) => setMaxPending(event.target.value)}
                    onBlur={() => save({ maxPending: Number(maxPending) })}
                  />
                </label>
                <div className="form-note">
                  队列已满或排队时间超过剩余审批时间时，请求会直接回退终端。
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">当前会话</div>
                {previews.length === 0 ? (
                  <div className="form-note">暂无会话记录。</div>
                ) : (
                  <div className="settings-session-list">
                    {previews.map((session) => {
                      const muted = (session.mutedUntil || 0) > Date.now()
                      return (
                        <div className="settings-session-row" key={session.key}>
                          <span
                            className="session-dot"
                            style={{ background: session.color }}
                            aria-hidden="true"
                          />
                          <b title={session.task || session.label}>{session.title}</b>
                          <span>{session.origin}</span>
                          <em>
                            {session.waiting > 0
                              ? `${session.waiting} 条等待`
                              : session.state === 'ended'
                                ? '已结束'
                                : '空闲'}
                          </em>
                          <button
                            className={`icon-btn ${muted ? 'active' : ''}`}
                            title={muted ? '取消静音提醒' : '静音提醒 30 分钟'}
                            onClick={() => void api.muteSession(session.key, muted ? 0 : 30)}
                          >
                            {muted ? '🔕' : '🔔'}
                          </button>
                          <select
                            className="mute-select"
                            value=""
                            onChange={(event) => {
                              const value = event.target.value
                              const minutes =
                                value === 'tomorrow'
                                  ? minutesUntilTomorrow()
                                  : Number(value)
                              if (minutes > 0) void api.muteSession(session.key, minutes)
                              event.currentTarget.value = ''
                            }}
                            aria-label="静音时长"
                            title="按会话静音"
                          >
                            <option value="">静音…</option>
                            <option value="30">30 分钟</option>
                            <option value="60">1 小时</option>
                            <option value="240">4 小时</option>
                            <option value="1440">24 小时</option>
                            <option value="tomorrow">直到明天 8:00</option>
                          </select>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          ) : null}

          {section === 'popup' ? (
            <>
              <div className="form-section">
                <div className="form-section-title">位置</div>
                <div className="segment-row">
                  {[
                    { id: 'primary' as const, label: '主屏幕' },
                    { id: 'cursor' as const, label: '跟随鼠标' },
                    { id: 'focus' as const, label: '焦点窗口' }
                  ].map((position) => {
                    const disabled =
                      position.id === 'focus' && state.app.platform !== 'win32'
                    return (
                      <button
                        key={position.id}
                        className={state.prefs.position === position.id ? 'active' : ''}
                        disabled={disabled}
                        title={disabled ? '仅 Windows 支持焦点窗口定位' : undefined}
                        onClick={() => save({ position: position.id })}
                      >
                        {position.label}
                      </button>
                    )
                  })}
                </div>
                <div className="form-note">
                  弹窗可以拖动；手动拖动后会记住位置，切换上面的位置选项会清除记忆。
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">焦点</div>
                <div className="segment-row">
                  {FOCUS_POLICIES.map((policy) => (
                    <button
                      key={policy.id}
                      className={state.prefs.focusPolicy === policy.id ? 'active' : ''}
                      onClick={() => save({ focusPolicy: policy.id as Prefs['focusPolicy'] })}
                    >
                      {policy.label}
                    </button>
                  ))}
                </div>
                <div className="form-note">
                  “从不抢焦点”只显示弹窗和角标，适合正在专注输入时使用；高风险审批仍可点击处理。
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">本机模式</div>
                <div className="segment-row">
                  <button
                    className={state.prefs.mode === 'popup' ? 'active' : ''}
                    onClick={() => save({ mode: 'popup' })}
                  >
                    置顶弹窗 · 快速审批
                  </button>
                  <button
                    className={state.prefs.mode === 'notify' ? 'active' : ''}
                    onClick={() => save({ mode: 'notify' })}
                  >
                    系统通知 · 仅提醒
                  </button>
                </div>
                {state.deploy.modeMismatch ? (
                  <div className="inline-warning">
                    已部署的钩子仍使用旧模式，需要重新接入或部署才会生效。
                  </div>
                ) : null}
              </div>

              <div className="form-section">
                <div className="form-section-title">超时回退</div>
                <div className="form-grid two">
                  <label className="field">
                    <span>弹窗默认超时（秒）</span>
                    <input
                      type="number"
                      min={15}
                      max={600}
                      value={timeout}
                      onChange={(event) => setTimeoutValue(event.target.value)}
                      onBlur={() => save({ timeoutSec: Number(timeout) })}
                    />
                  </label>
                </div>
                <div className="form-note">
                  超时后交给终端处理；远程部署在部署表单里单独设置钩子超时。
                </div>
              </div>
            </>
          ) : null}

          {section === 'network' ? (
            <>
              <div className="form-section">
                <div className="form-section-title">监听</div>
                <div className="form-grid two">
                  <label className="field">
                    <span>端口</span>
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>监听范围</span>
                    <div className="mini-seg">
                      <button
                        className={bindMode === 'all' ? 'active' : ''}
                        onClick={() => setBindMode('all')}
                      >
                        局域网
                      </button>
                      <button
                        className={bindMode === 'loopback' ? 'active' : ''}
                        onClick={() => setBindMode('loopback')}
                      >
                        仅本机
                      </button>
                    </div>
                  </label>
                </div>
                <div className="form-note">
                  当前：{state.server.listening ? '监听中' : '已停止'} ·{' '}
                  {state.network.bindMode === 'all'
                    ? '局域网内可访问，Token 与请求体为明文 HTTP'
                    : '仅 127.0.0.1 可访问'}
                </div>
                {state.network.error ? (
                  <div className="form-error">{state.network.error}</div>
                ) : null}
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={networkBusy}
                    onClick={() => void applyNetwork()}
                  >
                    {networkBusy ? '应用中…' : '应用并重启服务'}
                  </button>
                  {networkMessage ? <span className="form-note">{networkMessage}</span> : null}
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">本机地址</div>
                <label className="field">
                  <span>对外展示 / 部署默认回调地址</span>
                  <select
                    value={state.prefs.localIp}
                    onChange={(event) => save({ localIp: event.target.value })}
                  >
                    {state.network.addresses.map((address) => (
                      <option key={`${address.iface}-${address.address}`} value={address.address}>
                        {address.address}
                        {address.iface ? ` · ${address.iface}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="form-note">
                  多网卡、VPN 或 Docker 环境时请选择服务器能访问到的地址；端口变更后需要重新部署。
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">安全提示</div>
                <div className="form-note">
                  HTTP 服务使用 Bearer Token 做常量时间比较，但链路是明文。跨不可信网络时请使用 SSH
                  隧道或反向代理 TLS；也可以把监听范围改为“仅本机”配合端口转发。
                </div>
              </div>
            </>
          ) : null}

          {section === 'rules' ? (
            <>
              <div className="form-section">
                <div className="form-section-title">自动规则</div>
                <div className="form-note">
                  规则命中后直接按“允许”回传，不再弹窗；高风险操作永远不会自动应用规则。
                  匹配内容必须填写；要匹配所有命令请显式输入 *。规则保存在本机，可按会话、项目或全局生效。
                </div>
                <div className="form-grid two">
                  <label className="field">
                    <span>作用域</span>
                    <select
                      value={ruleScope}
                      onChange={(event) => setRuleScope(event.target.value as RuleScope)}
                    >
                      {SCOPES.map((scope) => (
                        <option key={scope.id} value={scope.id}>
                          {scope.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>工具</span>
                    <input
                      value={ruleTool}
                      placeholder="Bash / Edit / *"
                      onChange={(event) => setRuleTool(event.target.value)}
                    />
                  </label>
                  <label className="field wide">
                    <span>匹配命令 / 路径</span>
                    <input
                      value={rulePattern}
                      placeholder="git status:* 或 git * 或精确命令"
                      onChange={(event) => setRulePattern(event.target.value)}
                    />
                  </label>
                  {ruleScope === 'session' ? (
                    <label className="field wide">
                      <span>目标会话</span>
                      <select
                        value={ruleSessionKey}
                        disabled={waitingSessions.length === 0}
                        onChange={(event) => setRuleSessionKey(event.target.value)}
                      >
                        <option value="">
                          {waitingSessions.length === 0
                            ? '没有等待中的会话'
                            : '请选择目标会话'}
                        </option>
                        {waitingSessions.map((session) => (
                          <option key={session.key} value={session.key}>
                            {`${session.title} · ${session.origin}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {ruleScope === 'project' ? (
                    <>
                      <label className="field">
                        <span>项目名</span>
                        <input
                          value={ruleProject}
                          placeholder="例如 backend-api"
                          onChange={(event) => setRuleProject(event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>来源</span>
                        <select
                          value={ruleOrigin}
                          onChange={(event) => setRuleOrigin(event.target.value)}
                        >
                          <option value="">所有来源</option>
                          {ruleOrigins.map((origin) => (
                            <option key={origin} value={origin}>
                              {origin}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : null}
                </div>
                {ruleScope === 'session' && waitingSessions.length === 0 ? (
                  <div className="form-note">
                    当前没有等待中的会话，无法添加会话规则；请改用项目或全局作用域。
                  </div>
                ) : null}
                <div className="row rule-actions">
                  <span className="rule-expiry-label">有效期</span>
                  <select
                    className="rule-expiry"
                    value={ruleExpiry}
                    onChange={(event) =>
                      setRuleExpiry(event.target.value as 'forever' | '1h' | '24h')
                    }
                    aria-label="规则有效期"
                  >
                    <option value="forever">永久</option>
                    <option value="24h">24 小时</option>
                    <option value="1h">1 小时</option>
                  </select>
                  <button
                    className="btn primary"
                    disabled={ruleScope === 'session' && waitingSessions.length === 0}
                    onClick={() => void addRule()}
                  >
                    添加规则
                  </button>
                  {ruleMessage ? <span className="form-note">{ruleMessage}</span> : null}
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">已保存规则</div>
                {state.rules.length === 0 ? (
                  <div className="form-note">还没有自动规则。</div>
                ) : (
                  <div className="rule-list">
                    {state.rules.map((rule) => (
                      <div className={`rule-row ${rule.enabled ? '' : 'disabled'}`} key={rule.id}>
                        <div>
                          <b>{describeRule(rule)}</b>
                          <span>
                            创建于 {new Date(rule.createdAt).toLocaleString('zh-CN')}
                            {rule.scope === 'session' ? ' · 会话结束后可删除' : ''}
                          </span>
                        </div>
                        <div className="row">
                          <button
                            className="btn subtle compact"
                            onClick={() => void api.toggleRule(rule.id)}
                          >
                            {rule.enabled ? '停用' : '启用'}
                          </button>
                          <button
                            className="btn danger compact"
                            onClick={() => void api.removeRule(rule.id)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}

          {section === 'about' ? (
            <>
              <div className="form-section about-hero">
                <div className="about-mark" aria-hidden="true" />
                <div>
                  <h3>Claude Notify {state.app.version}</h3>
                  <p>远程 Claude Code 审批中转 · Electron + React</p>
                </div>
              </div>
              <div className="form-section">
                <div className="form-section-title">版本与更新</div>
                <div className="about-grid">
                  <span>应用版本</span>
                  <b>{state.app.version}</b>
                  <span>平台</span>
                  <b>{state.app.platform}</b>
                  <span>钩子版本</span>
                  <b>
                    {state.deploy.hookVersion || '未检测到'}
                    {state.deploy.hookStale ? ' · 需要更新' : ''}
                  </b>
                  <span>数据目录</span>
                  <b>~/.claude-notify</b>
                </div>
                <Toggle
                  checked={state.prefs.autoUpdate}
                  onChange={(value) => save({ autoUpdate: value })}
                  label="启动时自动检查更新"
                  hint="安装版可下载并重启安装；免安装版只下载 zip，不会自动替换当前目录"
                />
                <div className="row">
                  <button className="btn" onClick={() => void api.checkUpdate()}>
                    检查更新
                  </button>
                  {state.update.status === 'available' ||
                  state.update.status === 'downloading' ? (
                    <button
                      className="btn primary"
                      disabled={state.update.status === 'downloading'}
                      onClick={() => void api.downloadUpdate()}
                    >
                      {state.update.status === 'downloading'
                        ? `下载中 ${state.update.progress ?? 0}%`
                        : state.update.manual
                          ? '下载免安装包'
                          : '下载更新'}
                    </button>
                  ) : null}
                  {state.update.status === 'downloaded' &&
                  state.update.installable !== false ? (
                    <button className="btn primary" onClick={() => void api.installUpdate()}>
                      重启并安装
                    </button>
                  ) : null}
                  {state.update.status === 'downloaded' &&
                  state.update.installable === false &&
                  state.update.downloadedPath ? (
                    <button
                      className="btn"
                      onClick={() => void api.revealPath(state.update.downloadedPath as string)}
                    >
                      打开下载文件夹
                    </button>
                  ) : null}
                  {updateStatus ? <span className="form-note">{updateStatus}</span> : null}
                  {state.update.url ? (
                    <button
                      className="link"
                      onClick={() => void api.openExternal(state.update.url as string)}
                    >
                      打开发布页
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="form-section">
                <div className="form-section-title">快捷键</div>
                <div className="about-grid">
                  <span>允许 / 提交</span>
                  <b>Enter</b>
                  <span>交给终端</span>
                  <b>Esc</b>
                  <span>选择选项</span>
                  <b>1 – 9</b>
                  <span>打开设置</span>
                  <b>Cmd / Ctrl + ,</b>
                </div>
              </div>
              <div className="form-section">
                <div className="row">
                  <button className="btn" onClick={() => void api.openLogFile()}>
                    打开日志文件
                  </button>
                  <button className="btn subtle" onClick={() => void api.quit()}>
                    退出应用
                  </button>
                </div>
                <div className="form-note">
                  高风险操作会二次确认；规则不会自动应用高风险命令。
                </div>
              </div>
            </>
          ) : null}
        </div>

        <footer className="modal-actions">
          <span className="settings-footnote">
            {waitingCount > 0
              ? `${waitingCount} 个会话等待中 · 审批不会因打开设置而暂停`
              : `Claude Notify ${state.app.version} · 设置会立即保存`}
          </span>
          <button className="btn" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  )
}
