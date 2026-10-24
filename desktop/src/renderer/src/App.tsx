import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import DeployPanel from './DeployPanel'
import HistoryPanel from './HistoryPanel'
import Inbox from './Inbox'
import LogPanel from './LogPanel'
import Preferences, { type SettingsSection } from './Preferences'
import StatusDialog from './StatusDialog'
import { useAppState, useNow } from './hooks'

type Tab = 'inbox' | 'history' | 'logs'

export default function App(): React.JSX.Element {
  const state = useAppState()
  const now = useNow()
  const [tab, setTab] = useState<Tab>('inbox')
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const [deployOpen, setDeployOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [localBusy, setLocalBusy] = useState(false)

  const openSettings = useCallback((section: SettingsSection = 'general'): void => {
    setStatusOpen(false)
    setDeployOpen(false)
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  const openStatus = useCallback((): void => {
    setSettingsOpen(false)
    setDeployOpen(false)
    setStatusOpen(true)
  }, [])

  const openDeploy = useCallback((): void => {
    setSettingsOpen(false)
    setStatusOpen(false)
    setDeployOpen(true)
  }, [])

  useEffect(() => {
    const offCommand = api.onUiCommand((command) => {
      if (command === 'prefs') {
        openSettings('general')
      } else if (command === 'about') {
        openSettings('about')
      } else if (command === 'status') {
        openStatus()
      } else if (command === 'deploy') {
        openDeploy()
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
  }, [openDeploy, openSettings, openStatus])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openSettings])

  const connectLocal = async (): Promise<void> => {
    if (!state) return
    setLocalBusy(true)
    const response = await api.localDeploy(state.prefs.mode)
    setLocalBusy(false)
    if (response.ok && !state.onboarding.done) void api.finishOnboarding()
  }

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
  const hasDeployedProfile = state.deploy.profiles.some(
    (profile) => profile.status === 'deployed'
  )
  const statusTone = !serviceOk
    ? 'off'
    : state.deploy.hookStale || state.deploy.drift.length > 0 || state.deploy.modeMismatch
      ? 'warn'
      : 'on'

  return (
    <div className="shell main-shell" data-platform={isMac ? 'darwin' : state.app.platform}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <div className="brand-name">Claude Notify</div>
            <div className="brand-sub">审批收件箱</div>
          </div>
        </div>
        <div className="titlebar-actions">
          <div className="titlebar-tabs" role="group" aria-label="窗口面板">
            <button
              className={statusOpen ? 'active' : ''}
              aria-haspopup="dialog"
              aria-expanded={statusOpen}
              onClick={openStatus}
            >
              <i className={`status-dot ${statusTone}`} aria-hidden="true" />
              状态
            </button>
            <button
              className={deployOpen ? 'active' : ''}
              aria-haspopup="dialog"
              aria-expanded={deployOpen}
              onClick={openDeploy}
            >
              部署
            </button>
            <button
              className={settingsOpen ? 'active' : ''}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => openSettings()}
            >
              设置
            </button>
          </div>
          <button className="btn subtle compact" onClick={() => void api.hideWindow()}>
            隐藏到托盘
          </button>
        </div>
      </header>

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

      {state.deploy.drift.length > 0 ? (
        <div className="banner warn">
          <div>
            <b>部署配置需要更新</b>
            <span>
              {state.deploy.drift[0]}
              {state.deploy.drift.length > 1
                ? `（另有 ${state.deploy.drift.length - 1} 项）`
                : ''}
            </span>
          </div>
          <button
            className="btn compact"
            disabled={localBusy}
            onClick={() => {
              if (hasDeployedProfile) openDeploy()
              else void connectLocal()
            }}
          >
            {hasDeployedProfile ? '查看状态' : localBusy ? '接入中…' : '重新接入本机'}
          </button>
        </div>
      ) : null}

      {!state.onboarding.done ? (
        <section className="onboarding compact">
          <div className="onboarding-head">
            <div>
              <b>先完成接入</b>
              <span>接入 Claude Code 后，权限请求和问答会出现在待审批列表里。</span>
            </div>
            <button className="link" onClick={() => void api.finishOnboarding()}>
              跳过
            </button>
          </div>
          <div className="onboarding-actions">
            <button
              className="btn primary compact"
              disabled={localBusy}
              onClick={() => void connectLocal()}
            >
              {localBusy ? '接入中…' : '接入本机'}
            </button>
            <button className="btn compact" onClick={openDeploy}>
              远程部署
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

      <main className="workspace">
        <section className="card panel-card">
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
                {state.logs.length > 0 ? <b>{state.logs.length}</b> : null}
              </button>
            </div>
            <span className="card-hint">
              {tab === 'inbox'
                ? pending > 0
                  ? `${waitingSessions} 个会话 · 按剩余时间排序`
                  : '当前没有等待中的请求'
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
                onOpenDeploy={openDeploy}
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

          <footer className="panel-foot">
            <span className="board-keys">
              <span className="board-keys-label">弹窗</span>
              <kbd>Enter</kbd> 允许
              <kbd>Esc</kbd> 交给终端
              <kbd>1–9</kbd> 选项
            </span>
            <span className="panel-foot-hint">⌘/Ctrl + , 打开设置</span>
          </footer>
        </section>
      </main>

      <StatusDialog
        open={statusOpen}
        state={state}
        onClose={() => setStatusOpen(false)}
        onOpenSettings={openSettings}
      />

      <DeployPanel
        open={deployOpen}
        state={state}
        onClose={() => setDeployOpen(false)}
        onOpenSettings={openSettings}
      />

      <Preferences
        open={settingsOpen}
        state={state}
        section={settingsSection}
        onSection={setSettingsSection}
        onClose={() => setSettingsOpen(false)}
      />

      {state.toast ? (
        <div className="toast" role="status" aria-live="polite" aria-atomic="true">
          {state.toast}
        </div>
      ) : null}
    </div>
  )
}
