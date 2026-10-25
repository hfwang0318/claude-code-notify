import type {
  AppState,
  AppUpdateInfo,
  BindMode,
  DeployCacheView,
  DeployFormConfig,
  DeployResult,
  DeployTestResult,
  DesktopApi,
  PopupPosition,
  Prefs,
  SecurityInfo
} from '../../shared/types'
import { mockState } from './mock'

function createBrowserFallback(): DesktopApi {
  let state: AppState = structuredClone(mockState)
  const listeners = new Set<(next: AppState) => void>()
  const emit = (): void => {
    for (const listener of listeners) listener(structuredClone(state))
  }
  const toast = (message: string): void => {
    state = { ...state, toast: message }
    emit()
    window.setTimeout(() => {
      state = { ...state, toast: null }
      emit()
    }, 2400)
  }

  return {
    getState: async () => structuredClone(state),
    onState: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    respond: async () => {
      toast('浏览器预览模式：请在 Electron 中测试审批')
    },
    respondMany: async () => {
      toast('浏览器预览模式：请在 Electron 中测试审批')
    },
    snoozeApproval: async (id, minutes) => {
      state = {
        ...state,
        pending: state.pending.map((item) =>
          item.id === id
            ? { ...item, snoozedUntil: Date.now() + minutes * 60_000 }
            : item
        )
      }
      toast(`已稍后提醒 ${minutes} 分钟（预览）`)
      emit()
    },
    pauseApproval: async (id, paused) => {
      state = {
        ...state,
        pending: state.pending.map((item) =>
          item.id === id
            ? {
                ...item,
                paused,
                pausedRemainingMs: paused
                  ? Math.max(0, item.timeoutAt - Date.now())
                  : 0,
                timeoutAt: paused
                  ? Number.MAX_SAFE_INTEGER
                  : Date.now() + (item.pausedRemainingMs || 0)
              }
            : item
        )
      }
      emit()
    },
    acknowledgeExpired: async () => {
      state = { ...state, expired: [] }
      emit()
    },
    clearSkipped: async () => {
      state = { ...state, skipped: [] }
      emit()
    },
    collapsePopup: async () => {
      toast('浏览器预览模式：已收起弹窗')
    },
    pauseAll: async (paused: boolean) => {
      const now = Date.now()
      state = {
        ...state,
        pending: state.pending.map((item) => {
          if (item.snoozedUntil && item.snoozedUntil > now) return item
          return {
            ...item,
            paused,
            pausedRemainingMs: paused ? Math.max(0, item.timeoutAt - now) : 0,
            timeoutAt: paused
              ? Number.MAX_SAFE_INTEGER
              : Date.now() + (item.pausedRemainingMs || 0)
          }
        })
      }
      emit()
      toast(paused ? '已暂停全部倒计时（预览）' : '已恢复全部倒计时（预览）')
    },
    muteAll: async (minutes: number) => {
      state = {
        ...state,
        sessions: state.sessions.map((session) =>
          session.waiting > 0
            ? {
                ...session,
                mutedUntil: minutes > 0 ? Date.now() + minutes * 60 * 1000 : null
              }
            : session
        )
      }
      emit()
      toast(minutes > 0 ? `已静音所有等待会话（预览）` : '已取消全部静音（预览）')
    },
    dismissNotice: async () => {
      state = { ...state, notice: null }
      emit()
    },
    selectApproval: async () => {
      toast('浏览器预览模式：审批弹窗仅在 Electron 中显示')
    },
    onSelectApproval: () => () => undefined,
    onFocusSession: () => () => undefined,
    onUiCommand: () => () => undefined,
    toggleServer: async () => {
      state = {
        ...state,
        server: { ...state.server, listening: !state.server.listening }
      }
      emit()
    },
    testNotify: async () => {
      state = {
        ...state,
        server: { ...state.server, notified: state.server.notified + 1 }
      }
      toast('浏览器预览模式：已模拟通知')
      emit()
    },
    testApproval: async () => {
      toast('浏览器预览模式：审批弹窗仅在 Electron 中显示')
    },
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // clipboard can be unavailable in a plain browser
      }
      toast('已复制到剪贴板')
    },
    regenerateToken: async () => {
      state = {
        ...state,
        server: {
          ...state.server,
          token: `cn_live_${Math.random().toString(16).slice(2).padEnd(40, '0')}`
        }
      }
      toast('Token 已更新，需重新部署')
      emit()
    },
    getDeployCache: async (): Promise<DeployCacheView> => ({}),
    getSecurityInfo: async (): Promise<SecurityInfo> => ({
      available: false,
      label: '浏览器预览'
    }),
    pickKeyFile: async () => null,
    testDeploy: async (_config: DeployFormConfig): Promise<DeployTestResult> => ({
      ok: false,
      message: '浏览器预览模式：SSH 需要 Electron 主进程'
    }),
    startDeploy: async (_config: DeployFormConfig): Promise<DeployResult> => ({
      success: false,
      summary: '浏览器预览模式：部署需要 Electron 主进程',
      connectivity: false
    }),
    removeDeploy: async (_config: DeployFormConfig): Promise<DeployResult> => ({
      success: false,
      summary: '浏览器预览模式：部署需要 Electron 主进程',
      connectivity: false
    }),
    restoreDeploy: async (_config: DeployFormConfig): Promise<DeployResult> => ({
      success: false,
      summary: '浏览器预览模式：恢复需要 Electron 主进程',
      connectivity: false
    }),
    onDeployProgress: () => () => undefined,
    localStatus: async () => ({ deployed: false, mode: null }),
    localDeploy: async () => ({
      ok: false,
      message: '浏览器预览模式：本机接入需要 Electron 主进程'
    }),
    removeLocal: async () => ({
      ok: false,
      message: '浏览器预览模式：本机接入需要 Electron 主进程'
    }),
    restoreLocal: async () => ({
      ok: false,
      message: '浏览器预览模式：本机接入需要 Electron 主进程'
    }),
    setPrefs: async (patch: Partial<Prefs>) => {
      state = { ...state, prefs: { ...state.prefs, ...patch } }
      emit()
    },
    applyNetwork: async (config: { port: number; bindMode: BindMode }) => {
      state = {
        ...state,
        server: { ...state.server, port: config.port, bindMode: config.bindMode },
        network: { ...state.network, port: config.port, bindMode: config.bindMode }
      }
      emit()
      return { ok: true, message: '浏览器预览：已模拟应用' }
    },
    renameSession: async (key: string, label: string) => {
      state = {
        ...state,
        sessions: state.sessions.map((session) =>
          session.key === key ? { ...session, label } : session
        )
      }
      emit()
    },
    muteSession: async (key: string, minutes: number) => {
      state = {
        ...state,
        sessions: state.sessions.map((session) =>
          session.key === key
            ? {
                ...session,
                mutedUntil: minutes > 0 ? Date.now() + minutes * 60 * 1000 : null
              }
            : session
        )
      }
      emit()
    },
    addRule: async (rule) => {
      state = {
        ...state,
        rules: [
          {
            id: Math.random().toString(16).slice(2),
            createdAt: Date.now(),
            enabled: true,
            ...rule
          },
          ...state.rules
        ]
      }
      emit()
      toast('规则已保存（预览）')
    },
    removeRule: async (id: string) => {
      state = { ...state, rules: state.rules.filter((rule) => rule.id !== id) }
      emit()
    },
    toggleRule: async (id: string) => {
      state = {
        ...state,
        rules: state.rules.map((rule) =>
          rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
        )
      }
      emit()
    },
    historyExport: async () => ({ ok: false, message: '浏览器预览模式：无法导出' }),
    historyExportJson: async () => ({ ok: false, message: '浏览器预览模式：无法导出' }),
    historyClear: async () => {
      state = { ...state, history: [] }
      emit()
    },
    logsClear: async () => {
      state = { ...state, logs: [] }
      emit()
    },
    openLogs: async () => {
      toast('浏览器预览模式：无日志目录')
    },
    openLogFile: async () => {
      toast('浏览器预览模式：无日志文件')
    },
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    openFile: async () => {
      toast('浏览器预览模式：无法打开本地文件')
    },
    revealPath: async () => {
      toast('浏览器预览模式：无法打开下载目录')
    },
    checkUpdate: async (): Promise<AppUpdateInfo> => ({
      status: 'error',
      message: '浏览器预览模式：无法检查更新'
    }),
    downloadUpdate: async (): Promise<AppUpdateInfo> => ({
      status: 'error',
      message: '浏览器预览模式：无法下载更新'
    }),
    installUpdate: async () => {
      toast('浏览器预览模式：无法安装更新')
    },
    removeDeployProfile: async () => {
      toast('浏览器预览模式：无法删除部署目标')
    },
    checkDeployProfile: async (): Promise<DeployResult> => ({
      success: false,
      summary: '浏览器预览模式：无法检查服务器',
      connectivity: false
    }),
    finishOnboarding: async () => {
      state = { ...state, onboarding: { done: true } }
      emit()
    },
    hideWindow: async () => {
      toast('浏览器预览模式：无法隐藏窗口')
    },
    resizePopup: () => undefined,
    noticeReady: () => undefined,
    quit: async () => {
      toast('浏览器预览模式：无法退出')
    }
  }
}

export const api: DesktopApi = window.desktop ?? createBrowserFallback()

export function setPopupPosition(position: PopupPosition): Promise<void> {
  return api.setPrefs({ position })
}
