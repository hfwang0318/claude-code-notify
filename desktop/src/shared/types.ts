export type PopupPosition = 'primary' | 'cursor' | 'focus'

export type LogLevel =
  | 'info'
  | 'notify'
  | 'warn'
  | 'error'
  | 'allow'
  | 'deny'
  | 'timeout'
  | 'deploy'

export interface LogEntry {
  id: string
  ts: number
  level: LogLevel
  text: string
}

export interface ApprovalOption {
  id: string
  label: string
}

export interface ApprovalSuggestion {
  [key: string]: unknown
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface ApprovalQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
}

export interface ApprovalAnswer {
  question: string
  selected: string[]
  text: string
}

export type ApprovalKind = 'permission' | 'question'

export interface ApprovalItem {
  id: string
  requestId: string
  sessionId: string
  toolUseId: string
  transcriptPath: string
  kind: ApprovalKind
  tool: string
  project: string
  cwd: string
  message: string
  detail: string
  options: ApprovalOption[]
  suggestions: ApprovalSuggestion[]
  questions: ApprovalQuestion[]
  createdAt: number
  timeoutAt: number
  timeoutSec: number
}

export interface ApprovalExtra {
  index?: number
  answers?: ApprovalAnswer[]
}


export interface DeployFormConfig {
  mode: 'popup' | 'notify'
  host: string
  sshPort: number
  username: string
  authMethod: 'password' | 'key'
  password?: string
  keyPath?: string
  keyPassphrase?: string
  callbackIp: string
  callbackPort: number
  hookTimeout: number
  toolMatcher?: string
  rememberPassword: boolean
  envImport: boolean
  envShells: string[]
}

export interface DeployCacheView extends Partial<DeployFormConfig> {
  password?: string
}

export interface DeployTestResult {
  ok: boolean
  message: string
  home?: string
}

export interface DeployResult {
  success: boolean
  summary: string
  connectivity: boolean
}

export interface SecurityInfo {
  available: boolean
  label: string
}

export interface DeployState {
  status: 'idle' | 'running' | 'deployed' | 'error'
  host: string
  hooks: number
  message: string
}

export interface AppState {
  app: {
    version: string
    platform: string
  }
  server: {
    listening: boolean
    port: number
    token: string
    localIp: string
    notified: number
  }
  pending: ApprovalItem[]
  expired: ApprovalItem | null
  logs: LogEntry[]
  deploy: DeployState
  prefs: {
    position: PopupPosition
    mode: 'popup' | 'notify'
    timeoutSec: number
  }
  toast: string | null
}

export interface DesktopApi {
  getState(): Promise<AppState>
  onState(callback: (state: AppState) => void): () => void
  respond(id: string, decision: string, extra?: ApprovalExtra): Promise<void>
  acknowledgeExpired(): Promise<void>
  toggleServer(): Promise<void>
  testNotify(): Promise<void>
  testApproval(): Promise<void>
  copy(text: string): Promise<void>
  regenerateToken(): Promise<void>
  getDeployCache(): Promise<DeployCacheView>
  getSecurityInfo(): Promise<SecurityInfo>
  pickKeyFile(): Promise<string | null>
  testDeploy(config: DeployFormConfig): Promise<DeployTestResult>
  startDeploy(config: DeployFormConfig): Promise<DeployResult>
  onDeployProgress(callback: (progress: { level: LogLevel; message: string }) => void): () => void
  localStatus(): Promise<{ deployed: boolean; mode: 'popup' | 'notify' | null }>
  localDeploy(mode: 'popup' | 'notify'): Promise<{ ok: boolean; canceled?: boolean; message: string }>
  setPosition(position: PopupPosition): Promise<void>
  setMode(mode: 'popup' | 'notify'): Promise<void>
  openLogs(): Promise<void>
  hideWindow(): Promise<void>
  resizePopup(height: number): void
  quit(): Promise<void>
}
