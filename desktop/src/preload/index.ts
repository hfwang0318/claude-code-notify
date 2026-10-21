import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  ApprovalExtra,
  DeployCacheView,
  DeployFormConfig,
  DeployResult,
  DeployTestResult,
  DesktopApi,
  LogLevel,
  PopupPosition,
  SecurityInfo
} from '../shared/types'

const api: DesktopApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => callback(state)
    ipcRenderer.on('state:update', listener)
    return () => ipcRenderer.removeListener('state:update', listener)
  },
  respond: (id: string, decision: string, extra?: ApprovalExtra) =>
    ipcRenderer.invoke('approval:respond', id, decision, extra),
  acknowledgeExpired: () => ipcRenderer.invoke('approval:acknowledge'),
  toggleServer: () => ipcRenderer.invoke('server:toggle'),
  testNotify: () => ipcRenderer.invoke('test:notify'),
  testApproval: () => ipcRenderer.invoke('test:approval'),
  copy: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  regenerateToken: () => ipcRenderer.invoke('token:regenerate'),
  getDeployCache: (): Promise<DeployCacheView> => ipcRenderer.invoke('deploy:cache'),
  getSecurityInfo: (): Promise<SecurityInfo> => ipcRenderer.invoke('security:info'),
  pickKeyFile: (): Promise<string | null> => ipcRenderer.invoke('deploy:pick-key'),
  testDeploy: (config: DeployFormConfig): Promise<DeployTestResult> =>
    ipcRenderer.invoke('deploy:test', config),
  startDeploy: (config: DeployFormConfig): Promise<DeployResult> =>
    ipcRenderer.invoke('deploy:start', config),
  localStatus: () => ipcRenderer.invoke('local:status'),
  localDeploy: (mode: 'popup' | 'notify') => ipcRenderer.invoke('local:deploy', mode),
  onDeployProgress: (callback: (progress: { level: LogLevel; message: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: { level: LogLevel; message: string }
    ): void => callback(progress)
    ipcRenderer.on('deploy:progress', listener)
    return () => ipcRenderer.removeListener('deploy:progress', listener)
  },
  setPosition: (position: PopupPosition) => ipcRenderer.invoke('pref:position', position),
  setMode: (mode: 'popup' | 'notify') => ipcRenderer.invoke('pref:mode', mode),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  resizePopup: (height: number) => ipcRenderer.send('popup:resize', height),
  quit: () => ipcRenderer.invoke('app:quit')
}

contextBridge.exposeInMainWorld('desktop', api)
