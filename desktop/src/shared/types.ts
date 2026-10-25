export type PopupPosition = 'primary' | 'cursor' | 'focus'
export type ThemeMode = 'system' | 'dark' | 'light'
export type FocusPolicy = 'first' | 'always' | 'never'
export type BindMode = 'all' | 'loopback'
export type DeployMode = 'popup' | 'notify'
export type FontStyle = 'system' | 'rounded' | 'serif' | 'mono'
export type FontSize = 'small' | 'normal' | 'large' | 'xlarge'

export type LogLevel =
  | 'info'
  | 'notify'
  | 'warn'
  | 'error'
  | 'allow'
  | 'deny'
  | 'timeout'
  | 'cancelled'
  | 'ask'
  | 'answer'
  | 'suggestion'
  | 'rule'
  | 'deploy'

export type DecisionSource =
  | 'popup'
  | 'terminal'
  | 'timeout'
  | 'rule'
  | 'admission'
  | 'server-stop'
  | 'test'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface RiskInfo {
  level: RiskLevel
  reasons: string[]
}

export interface LogEntry {
  id: string
  ts: number
  level: LogLevel
  text: string
}

/** Transient "Claude finished a turn" notice shown in the popup window. */
export interface CompletionNotice {
  id: string
  title: string
  body: string
  sessionKey: string
  createdAt: number
  /** Session identity, so a completion notice is as distinguishable as an approval. */
  sessionTitle?: string
  sessionLabel?: string
  shortId?: string
  color?: string
  task?: string
  branch?: string
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

export interface SessionInfo {
  key: string
  sessionId: string
  origin: string
  label: string
  /** Human-facing name: custom label, first-task auto name, or "project #2". */
  title: string
  /** First task snapshot used as the auto title; empty when unavailable. */
  topic: string
  /** First four characters of the session id; stable handle to match terminals/logs. */
  shortId: string
  /** One-line summary of the current task, extracted from the transcript by the hook. */
  task: string
  /** Current git branch of the working directory, when known. */
  branch: string
  /** 1-based position among sessions that share origin + project. */
  ordinal: number
  /** Number of sessions sharing origin + project (1 when unique). */
  groupSize: number
  firstSeen: number
  customLabel: boolean
  project: string
  cwd: string
  tty: string
  terminal: string
  lastSeen: number
  waiting: number
  state: 'waiting' | 'idle' | 'ended'
  color: string
  mutedUntil: number | null
}

export interface ApprovalItem {
  id: string
  requestId: string
  sessionId: string
  sessionKey: string
  sessionLabel: string
  origin: string
  promptId: string
  toolUseId: string
  transcriptPath: string
  kind: ApprovalKind
  tool: string
  project: string
  cwd: string
  tty: string
  terminal: string
  /** Task summary forwarded by the hook (last human prompt of this session). */
  task: string
  /** Last assistant explanation before the tool call, when the hook can read it. */
  intent?: string
  /** Git branch forwarded by the hook. */
  branch: string
  message: string
  detail: string
  toolInput: Record<string, unknown>
  options: ApprovalOption[]
  suggestions: ApprovalSuggestion[]
  questions: ApprovalQuestion[]
  risk: RiskInfo
  correlation: 'exact' | 'unmatched' | 'unknown'
  createdAt: number
  timeoutAt: number
  timeoutSec: number
  /** True while the countdown is paused by the user (typing a long answer). */
  paused?: boolean
  /** Remaining milliseconds captured when the countdown was paused. */
  pausedRemainingMs?: number
  /** When set, the popup stays hidden until this timestamp; the timeout keeps running. */
  snoozedUntil?: number
}

export interface ApprovalExtra {
  index?: number
  answers?: ApprovalAnswer[]
  /** Optional message forwarded to Claude when the user denies a request. */
  reason?: string
}

/**
 * A request that never reached the popup because the admission control sent it
 * straight back to the terminal. Kept in state so "why did nothing appear?" is
 * answerable without opening the log.
 */
export type SkipReason = 'overloaded' | 'deadline'

export interface SkippedApproval {
  id: string
  ts: number
  sessionKey: string
  sessionLabel: string
  origin: string
  tool: string
  command: string
  reason: SkipReason
  /** How many distinct decision groups were already waiting. */
  pendingGroups: number
  timeoutSec: number
}

export interface ApprovalRecord {
  id: string
  ts: number
  sessionKey: string
  sessionLabel: string
  origin: string
  project: string
  tool: string
  message: string
  command: string
  decision: string
  source: DecisionSource
  latencyMs: number
  risk: RiskLevel
  /** Rule that produced an automatic decision, for audit and analytics. */
  ruleId?: string
  /** User-supplied deny explanation. */
  reason?: string
}

export type RuleScope = 'session' | 'project' | 'global'

export interface ApprovalRule {
  id: string
  scope: RuleScope
  project?: string
  sessionKey?: string
  /** 绑定的来源；为空表示适用于所有来源。 */
  origin?: string
  tool: string
  pattern: string
  createdAt: number
  enabled: boolean
  /** Optional expiry for time-boxed "remember this" rules. */
  expiresAt?: number
}

export interface DeployFormConfig {
  mode: DeployMode
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
  origin?: string
  rememberPassword: boolean
  envImport: boolean
  envShells: string[]
  hostFingerprint?: string
}

export interface DeployCacheView extends Partial<DeployFormConfig> {
  password?: string
}

export interface DeployTestResult {
  ok: boolean
  message: string
  home?: string
  connectivity?: boolean
  connectivityMessage?: string
  fingerprint?: string
  knownFingerprint?: boolean
  code?: string
}

export interface DeployProfile {
  id: string
  name: string
  origin: string
  host: string
  sshPort: number
  username: string
  authMethod: 'password' | 'key'
  /** Remembered for key-auth profiles so multi-server deployments do not re-pick it. */
  keyPath?: string
  mode: DeployMode
  callbackIp: string
  callbackPort: number
  hookTimeout: number
  toolMatcher: string
  lastDeployAt: number | null
  status: 'deployed' | 'failed' | 'unknown'
  hooks: number
  hookVersion: string
  /** Short hash of the token used at deploy time; absent on older profiles. */
  tokenFingerprint?: string
  /** Last failure or health-check message, for the profile list. */
  lastError?: string
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
  localMode: DeployMode | null
  localHooks: number
  hookVersion: string
  hookStale: boolean
  modeMismatch: boolean
  profiles: DeployProfile[]
  /** Human-readable deployment drift, newest checks first, capped for the UI. */
  drift: string[]
}

export interface NetworkAddress {
  address: string
  iface: string
  preferred: boolean
}

export interface NetworkInfo {
  addresses: NetworkAddress[]
  port: number
  bindMode: BindMode
  conflict: boolean
  error: string
}

export interface AppUpdateInfo {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'latest'
    | 'error'
  latest?: string
  url?: string
  message?: string
  /** 0-100 while a package is downloading. */
  progress?: number
  /** True when only the release page / manual zip is available (portable/dev build). */
  manual?: boolean
  /** False when the downloaded artifact must be installed manually. */
  installable?: boolean
  /** Downloaded portable/macOS zip, when a manual update was fetched. */
  downloadedPath?: string
}

export interface Prefs {
  position: PopupPosition
  mode: DeployMode
  timeoutSec: number
  theme: ThemeMode
  fontStyle: FontStyle
  fontSize: FontSize
  focusPolicy: FocusPolicy
  sound: boolean
  systemNotifications: boolean
  enterConfirmsHighRisk: boolean
  bindMode: BindMode
  port: number
  localIp: string
  admissionControl: boolean
  maxPending: number
  quietHoursEnabled: boolean
  /** Local time in HH:mm, inclusive start. */
  quietHoursStart: string
  /** Local time in HH:mm, exclusive end; may be before start for overnight windows. */
  quietHoursEnd: string
  /** Check GitHub for a newer packaged build on launch. */
  autoUpdate: boolean
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
    localIps: string[]
    notified: number
    bindMode: BindMode
    error: string
  }
  sessions: SessionInfo[]
  pending: ApprovalItem[]
  expired: ApprovalItem[]
  /** Requests the admission control returned to the terminal without showing. */
  skipped: SkippedApproval[]
  notice: CompletionNotice | null
  history: ApprovalRecord[]
  rules: ApprovalRule[]
  logs: LogEntry[]
  deploy: DeployState
  network: NetworkInfo
  prefs: Prefs
  onboarding: { done: boolean }
  update: AppUpdateInfo
  toast: string | null
}

export interface DesktopApi {
  getState(): Promise<AppState>
  onState(callback: (state: AppState) => void): () => void
  respond(id: string, decision: string, extra?: ApprovalExtra): Promise<void>
  respondMany(ids: string[], decision: string, extra?: ApprovalExtra): Promise<void>
  pauseApproval(id: string, paused: boolean): Promise<void>
  snoozeApproval(id: string, minutes: number): Promise<void>
  acknowledgeExpired(id?: string): Promise<void>
  clearSkipped(id?: string): Promise<void>
  collapsePopup(): Promise<void>
  pauseAll(paused: boolean): Promise<void>
  muteAll(minutes: number): Promise<void>
  dismissNotice(): Promise<void>
  selectApproval(id: string): Promise<void>
  onSelectApproval(callback: (id: string) => void): () => void
  onFocusSession(callback: (sessionKey: string) => void): () => void
  onUiCommand(callback: (command: 'prefs' | 'about' | 'inbox' | 'status' | 'deploy') => void): () => void
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
  removeDeploy(config: DeployFormConfig): Promise<DeployResult>
  restoreDeploy(config: DeployFormConfig): Promise<DeployResult>
  /** Optional so the browser-preview fallback can omit it without a main process. */
  cancelDeploy?: () => Promise<{ ok: boolean; message?: string }>
  onDeployProgress(callback: (progress: { level: LogLevel; message: string }) => void): () => void
  localStatus(): Promise<{ deployed: boolean; mode: DeployMode | null }>
  localDeploy(mode: DeployMode): Promise<{ ok: boolean; canceled?: boolean; message: string }>
  removeLocal(): Promise<{ ok: boolean; message: string }>
  restoreLocal(): Promise<{ ok: boolean; message: string }>
  setPrefs(patch: Partial<Prefs>): Promise<void>
  applyNetwork(config: { port: number; bindMode: BindMode }): Promise<{ ok: boolean; message: string }>
  renameSession(key: string, label: string): Promise<void>
  muteSession(key: string, minutes: number): Promise<void>
  addRule(rule: {
    scope: RuleScope
    tool: string
    pattern: string
    project?: string
    sessionKey?: string
    origin?: string
    expiresAt?: number
  }): Promise<void>
  removeRule(id: string): Promise<void>
  toggleRule(id: string): Promise<void>
  historyExport(): Promise<{ ok: boolean; message: string }>
  historyExportJson(): Promise<{ ok: boolean; message: string }>
  historyClear(): Promise<void>
  logsClear(): Promise<void>
  openLogs(): Promise<void>
  openLogFile(): Promise<void>
  openExternal(url: string): Promise<void>
  openFile(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  checkUpdate(): Promise<AppUpdateInfo>
  downloadUpdate(): Promise<AppUpdateInfo>
  installUpdate(): Promise<void>
  removeDeployProfile(id: string): Promise<void>
  checkDeployProfile(id: string): Promise<DeployResult>
  finishOnboarding(): Promise<void>
  hideWindow(): Promise<void>
  resizePopup(height: number): void
  /** The completion notice has rendered; reveal/resize it after this measurement. */
  noticeReady(id: string, height: number): void
  quit(): Promise<void>
}
