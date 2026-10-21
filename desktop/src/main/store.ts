import { randomUUID } from 'node:crypto'
import type {
  AppState,
  ApprovalItem,
  LogEntry,
  LogLevel,
  PopupPosition
} from '../shared/types'

export class Store {
  private state: AppState
  private listeners = new Set<(state: AppState) => void>()

  constructor(options: {
    token: string
    port: number
    localIp: string
    version: string
    platform: string
  }) {
    this.state = {
      app: { version: options.version, platform: options.platform },
      server: {
        listening: false,
        port: options.port,
        token: options.token,
        localIp: options.localIp,
        notified: 0
      },
      pending: [],
      expired: null,
      logs: [],
      deploy: {
        status: 'idle',
        host: '',
        hooks: 0,
        message: '尚未部署'
      },
      prefs: {
        position: 'cursor',
        mode: 'popup',
        timeoutSec: 240
      },
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
    this.state.logs = [...this.state.logs, entry].slice(-500)
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

  setExpired(item: ApprovalItem | null): void {
    this.state.expired = item
    this.emit()
  }

  setListening(listening: boolean): void {
    this.state.server.listening = listening
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

  setToast(message: string | null): void {
    this.state.toast = message
    this.emit()
    if (message) {
      setTimeout(() => {
        if (this.state.toast === message) {
          this.state.toast = null
          this.emit()
        }
      }, 2200)
    }
  }

  seedDemoLogs(): void {
    const now = Date.now()
    this.state.logs = [
      {
        id: randomUUID(),
        ts: now - 212000,
        level: 'info',
        text: 'HTTP 服务已启动 · 0.0.0.0:18765 · 线程池就绪'
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
      status: 'deployed',
      host: 'deploy@192.168.1.20:22',
      hooks: 2,
      message: '上次成功 16:15'
    }
    this.emit()
  }
}
