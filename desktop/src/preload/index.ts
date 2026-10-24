import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  ApprovalExtra,
  AppUpdateInfo,
  BindMode,
  DeployCacheView,
  DeployFormConfig,
  DeployResult,
  DeployTestResult,
  DesktopApi,
  LogLevel,
  Prefs,
  RuleScope,
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
  respondMany: (ids: string[], decision: string, extra?: ApprovalExtra) =>
    ipcRenderer.invoke('approval:respond-many', ids, decision, extra),
  pauseApproval: (id: string, paused: boolean) =>
    ipcRenderer.invoke('approval:pause', id, paused),
  snoozeApproval: (id: string, minutes: number) =>
    ipcRenderer.invoke('approval:snooze', id, minutes),
  acknowledgeExpired: (id?: string) => ipcRenderer.invoke('approval:acknowledge', id),
  dismissNotice: () => ipcRenderer.invoke('notice:dismiss'),
  selectApproval: (id: string) => ipcRenderer.invoke('approval:select', id),
  onSelectApproval: (callback: (id: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string): void => callback(id)
    ipcRenderer.on('popup:select', listener)
    return () => ipcRenderer.removeListener('popup:select', listener)
  },
  onFocusSession: (callback: (sessionKey: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, key: string): void => callback(key)
    ipcRenderer.on('focus:session', listener)
    return () => ipcRenderer.removeListener('focus:session', listener)
  },
  onUiCommand: (callback: (command: 'prefs' | 'about' | 'inbox' | 'status' | 'deploy') => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      command: 'prefs' | 'about' | 'inbox' | 'status' | 'deploy'
    ): void => callback(command)
    ipcRenderer.on('ui:command', listener)
    return () => ipcRenderer.removeListener('ui:command', listener)
  },
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
  removeDeploy: (config: DeployFormConfig): Promise<DeployResult> =>
    ipcRenderer.invoke('deploy:remove', config),
  restoreDeploy: (config: DeployFormConfig): Promise<DeployResult> =>
    ipcRenderer.invoke('deploy:restore', config),
  cancelDeploy: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('deploy:cancel'),
  onDeployProgress: (callback: (progress: { level: LogLevel; message: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: { level: LogLevel; message: string }
    ): void => callback(progress)
    ipcRenderer.on('deploy:progress', listener)
    return () => ipcRenderer.removeListener('deploy:progress', listener)
  },
  localStatus: () =>
    ipcRenderer.invoke('local:status') as Promise<{
      deployed: boolean
      mode: 'popup' | 'notify' | null
      stale?: boolean
      version?: string
    }>,
  localDeploy: (mode: 'popup' | 'notify') => ipcRenderer.invoke('local:deploy', mode),
  removeLocal: () => ipcRenderer.invoke('local:remove'),
  restoreLocal: () => ipcRenderer.invoke('local:restore'),
  setPrefs: (patch: Partial<Prefs>) => ipcRenderer.invoke('prefs:set', patch),
  applyNetwork: (config: { port: number; bindMode: BindMode }) =>
    ipcRenderer.invoke('network:apply', config),
  renameSession: (key: string, label: string) =>
    ipcRenderer.invoke('session:rename', key, label),
  muteSession: (key: string, minutes: number) =>
    ipcRenderer.invoke('session:mute', key, minutes),
  addRule: (rule: {
    scope: RuleScope
    tool: string
    pattern: string
    project?: string
    sessionKey?: string
    origin?: string
    expiresAt?: number
  }) => ipcRenderer.invoke('rules:add', rule),
  removeRule: (id: string) => ipcRenderer.invoke('rules:remove', id),
  toggleRule: (id: string) => ipcRenderer.invoke('rules:toggle', id),
  historyExport: () => ipcRenderer.invoke('history:export'),
  historyExportJson: () => ipcRenderer.invoke('history:export-json'),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  logsClear: () => ipcRenderer.invoke('logs:clear'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  openLogFile: () => ipcRenderer.invoke('logs:open-file'),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
  openFile: (path: string) => ipcRenderer.invoke('file:open', path),
  checkUpdate: (): Promise<AppUpdateInfo> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<AppUpdateInfo> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  removeDeployProfile: (id: string) => ipcRenderer.invoke('deploy:profile-remove', id),
  checkDeployProfile: (id: string): Promise<DeployResult> =>
    ipcRenderer.invoke('deploy:profile-check', id),
  finishOnboarding: () => ipcRenderer.invoke('onboarding:finish'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  resizePopup: (height: number) => ipcRenderer.send('popup:resize', height),
  quit: () => ipcRenderer.invoke('app:quit')
}

contextBridge.exposeInMainWorld('desktop', api)
