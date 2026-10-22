import { randomUUID } from 'node:crypto'
import type {
  AppState,
  AppUpdateInfo,
  ApprovalItem,
  ApprovalRecord,
  ApprovalRule,
  BindMode,
  DeployState,
  LogEntry,
  LogLevel,
  NetworkInfo,
  PopupPosition,
  Prefs,
  SessionInfo
} from '../shared/types'

export interface StoreOptions {
  token: string
  port: number
  localIp: string
  localIps: string[]
  version: string
  platform: string
  bindMode: BindMode
  prefs?: Partial<Prefs>
}

export class Store {
  private state: AppState
  private listeners = new Set<(state: AppState) => void>()

  constructor(options: StoreOptions) {
    const prefs: Prefs = {
      position: 'cursor',
      mode: 'popup',
      timeoutSec: 240,
      theme: 'system',
      fontStyle: 'system',
      fontSize: 'normal',
      focusPolicy: 'first',
      sound: true,
      systemNotifications: true,
      enterConfirmsHighRisk: true,
      bindMode: options.bindMode,
      port: options.port,
      localIp: options.localIp,
      admissionControl: true,
      maxPending: 8,
      ...options.prefs
    }
    this.state = {
      app: { version: options.version, platform: options.platform },
      server: {
        listening: false,
        port: options.port,
        token: options.token,
        localIp: options.localIp,
        localIps: options.localIps,
        notified: 0,
        bindMode: options.bindMode,
        error: ''
      },
      sessions: [],
      pending: [],
      expired: [],
      history: [],
      rules: [],
      logs: [],
      deploy: {
        status: 'idle',
        host: '',
        hooks: 0,
        message: '尚未部署',
        localMode: null,
        localHooks: 0,
        hookVersion: '',
        hookStale: false,
        modeMismatch: false,
        profiles: []
      },
      network: {
        addresses: options.localIps.map((address) => ({
          address,
          iface: '',
          preferred: address === options.localIp
        })),
        port: options.port,
        bindMode: options.bindMode,
        conflict: false,
        error: ''
      },
      prefs,
      onboarding: { done: false },
      update: { status: 'idle' },
      toast: null
    }
  }

  get(): AppState {
    return this.state
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state)
  }

  patch(mutate: (draft: AppState) => void): void {
    mutate(this.state)
    this.emit()
  }

  log(level: LogLevel, text: string): void {
    const entry: LogEntry = {
      id: randomUUID(),
      ts: Date.now(),
      level,
      text
    }
    this.state.logs = [...this.state.logs, entry].slice(-800)
    this.emit()
  }

  clearLogs(): void {
    this.state.logs = []
    this.emit()
  }

  addPending(item: ApprovalItem): void {
    this.state.pending = [...this.state.pending, item]
    this.emit()
  }

  removePending(id: string): void {
    this.state.pending = this.state.pending.filter((item) => item.id !== id)
    this.emit()
  }

  setPending(items: ApprovalItem[]): void {
    this.state.pending = items
    this.emit()
  }

  addExpired(item: ApprovalItem): void {
    this.state.expired = [item, ...this.state.expired.filter((entry) => entry.id !== item.id)].slice(
      0,
      20
    )
    this.emit()
  }

  clearExpired(id?: string): void {
    this.state.expired = id
      ? this.state.expired.filter((entry) => entry.id !== id)
      : []
    this.emit()
  }

  setSessions(sessions: SessionInfo[]): void {
    this.state.sessions = sessions
    this.emit()
  }

  setHistory(history: ApprovalRecord[]): void {
    this.state.history = history
    this.emit()
  }

  addHistory(record: ApprovalRecord): void {
    this.state.history = [record, ...this.state.history].slice(0, 300)
    this.emit()
  }

  setRules(rules: ApprovalRule[]): void {
    this.state.rules = rules
    this.emit()
  }

  setListening(listening: boolean): void {
    this.state.server.listening = listening
    this.emit()
  }

  setServerError(error: string): void {
    this.state.server.error = error
    this.state.network.error = error
    this.emit()
  }

  setNetwork(network: Partial<NetworkInfo>): void {
    this.state.network = { ...this.state.network, ...network }
    this.state.server.port = this.state.network.port
    this.state.prefs.port = this.state.network.port
    this.state.server.bindMode = this.state.network.bindMode
    this.state.prefs.bindMode = this.state.network.bindMode
    this.state.server.error = this.state.network.error
    this.emit()
  }

  setToken(token: string): void {
    this.state.server.token = token
    this.emit()
  }

  setPosition(position: PopupPosition): void {
    this.state.prefs.position = position
    this.emit()
  }

  setMode(mode: 'popup' | 'notify'): void {
    this.state.prefs.mode = mode
    this.emit()
  }

  setPrefs(patch: Partial<Prefs>): void {
    this.state.prefs = { ...this.state.prefs, ...patch }
    if (typeof patch.port === 'number') this.state.server.port = patch.port
    if (patch.bindMode) this.state.server.bindMode = patch.bindMode
    if (patch.localIp) this.state.server.localIp = patch.localIp
    this.emit()
  }

  setDeploy(patch: Partial<DeployState>): void {
    this.state.deploy = { ...this.state.deploy, ...patch }
    this.emit()
  }

  setOnboarding(done: boolean): void {
    this.state.onboarding = { done }
    this.emit()
  }

  setUpdate(update: AppUpdateInfo): void {
    this.state.update = update
    this.emit()
  }

  setToast(message: string | null): void {
    this.state.toast = message
    this.emit()
    if (message) {
      setTimeout(() => {
        if (this.state.toast === message) {
          this.state.toast = null
          this.emit()
        }
      }, 2400)
    }
  }

  seedDemoLogs(): void {
    const now = Date.now()
    this.state.logs = [
      {
        id: randomUUID(),
        ts: now - 212000,
        level: 'info',
        text: 'HTTP 服务已启动 · 0.0.0.0:18765 · Bearer Token 校验开启'
      },
      {
        id: randomUUID(),
        ts: now - 176000,
        level: 'deploy',
        text: 'settings.json 合并完成 · 旧 PreToolUse 残留已清理'
      },
      {
        id: randomUUID(),
        ts: now - 96000,
        level: 'notify',
        text: '通知 · 会话 7f3a · 等待输入 · 已推送系统通知'
      },
      {
        id: randomUUID(),
        ts: now - 43000,
        level: 'allow',
        text: 'Bash · git status · 弹窗允许 · 2.6s'
      },
      {
        id: randomUUID(),
        ts: now - 21000,
        level: 'deny',
        text: 'Edit · src/app.py · 拒绝并附原因 · 焦点回到终端'
      }
    ]
    this.state.server.notified = 18
    this.state.deploy = {
      ...this.state.deploy,
      status: 'deployed',
      host: 'deploy@192.168.1.20:22',
      hooks: 2,
      message: '上次成功 16:15'
    }
    this.emit()
  }
}
