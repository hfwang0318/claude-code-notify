import type {
  AppState,
  DeployCacheView,
  DeployFormConfig,
  DeployResult,
  DeployTestResult,
  DesktopApi,
  PopupPosition,
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
    }, 2200)
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
    acknowledgeExpired: async () => undefined,
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
    localStatus: async () => ({ deployed: false, mode: null }),
    localDeploy: async () => ({ ok: false, message: '浏览器预览模式：本机接入需要 Electron 主进程' }),
    onDeployProgress: () => () => undefined,
    setPosition: async (position: PopupPosition) => {
      state = { ...state, prefs: { ...state.prefs, position } }
      emit()
    },
    setMode: async (mode: 'popup' | 'notify') => {
      state = { ...state, prefs: { ...state.prefs, mode } }
      emit()
    },
    openLogs: async () => {
      toast('浏览器预览模式：无日志目录')
    },
    hideWindow: async () => {
      toast('浏览器预览模式：无法隐藏窗口')
    },
    resizePopup: () => undefined,
    quit: async () => {
      toast('浏览器预览模式：无法退出')
    }
  }
}

export const api: DesktopApi = window.desktop ?? createBrowserFallback()
