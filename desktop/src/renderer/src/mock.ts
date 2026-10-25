import type { AppState } from '../../shared/types'

const now = Date.now()

export const mockState: AppState = {
  app: { version: '0.6.1', platform: 'darwin' },
  server: {
    listening: true,
    port: 18765,
    token: 'cn_live_9f4c2b7a8e1d6f3a5c0b9e8d7a6f5c4b3a2e1d0c',
    localIp: '192.168.1.20',
    localIps: ['192.168.1.20', '10.8.0.4'],
    notified: 18,
    bindMode: 'all',
    error: ''
  },
  sessions: [
    {
      key: '本机:session-front',
      sessionId: 'session-front',
      origin: '本机',
      label: '前端 · iTerm2 · ttys004',
      title: '修复多会话弹窗无法区分任务的问题',
      topic: '修复多会话弹窗无法区分任务的问题',
      shortId: '3c9f',
      task: '修复多会话弹窗无法区分任务的问题',
      branch: 'feat/popup-identity',
      ordinal: 1,
      groupSize: 2,
      firstSeen: now - 600000,
      customLabel: false,
      project: 'claude-code-notify',
      cwd: '~/workspace/claude-code-notify',
      tty: 'ttys004',
      terminal: 'iTerm2',
      lastSeen: now - 5000,
      waiting: 1,
      state: 'waiting',
      color: '#e07a5a',
      mutedUntil: null
    },
    {
      key: '本机:session-api',
      sessionId: 'session-api',
      origin: '本机',
      label: '后端 · VS Code · ttys007',
      title: '给审批接口补上 trace_id 透传',
      topic: '给审批接口补上 trace_id 透传',
      shortId: '81bd',
      task: '给审批接口补上 trace_id 透传',
      branch: 'fix/trace-id',
      ordinal: 1,
      groupSize: 1,
      firstSeen: now - 900000,
      customLabel: true,
      project: 'backend-api',
      cwd: '~/workspace/backend-api',
      tty: 'ttys007',
      terminal: 'VS Code',
      lastSeen: now - 120000,
      waiting: 0,
      state: 'idle',
      color: '#8fd1ae',
      mutedUntil: null
    }
  ],
  pending: [],
  expired: [],
  skipped: [],
  history: [],
  rules: [],
  logs: [
    {
      id: 'l1',
      ts: now - 212000,
      level: 'info',
      text: 'HTTP 服务已启动 · 0.0.0.0:18765 · Bearer Token 校验开启'
    },
    {
      id: 'l2',
      ts: now - 176000,
      level: 'deploy',
      text: 'settings.json 合并完成 · 旧 PreToolUse 残留已清理'
    },
    {
      id: 'l3',
      ts: now - 96000,
      level: 'notify',
      text: '通知 · 前端 · 等待输入 · 已推送系统通知'
    },
    {
      id: 'l4',
      ts: now - 43000,
      level: 'allow',
      text: '前端 · 本机 · Bash · git status · 允许'
    },
    {
      id: 'l5',
      ts: now - 21000,
      level: 'deny',
      text: '后端 · prod-api · Edit · src/app.py · 拒绝'
    }
  ],
  deploy: {
    status: 'deployed',
    host: 'deploy@192.168.1.20:22',
    hooks: 2,
    message: '上次成功 16:15',
    localMode: 'popup',
    localHooks: 2,
    hookVersion: '2',
    hookStale: false,
    modeMismatch: false,
    drift: [],
    profiles: [
      {
        id: 'deploy@192.168.1.20:22',
        name: 'prod-api',
        origin: 'prod-api',
        host: '192.168.1.20',
        sshPort: 22,
        username: 'deploy',
        authMethod: 'key',
        mode: 'popup',
        callbackIp: '192.168.1.20',
        callbackPort: 18765,
        hookTimeout: 300,
        toolMatcher: '',
        lastDeployAt: now - 3600000,
        status: 'deployed',
        hooks: 2,
        hookVersion: '2'
      }
    ]
  },
  network: {
    addresses: [
      { address: '192.168.1.20', iface: 'en0', preferred: true },
      { address: '10.8.0.4', iface: 'utun3', preferred: false }
    ],
    port: 18765,
    bindMode: 'all',
    conflict: false,
    error: ''
  },
  prefs: {
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
    bindMode: 'all',
    port: 18765,
    localIp: '192.168.1.20',
    admissionControl: true,
    maxPending: 8,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    autoUpdate: true
  },
  onboarding: { done: true },
  update: { status: 'idle' },
  notice: null,
  toast: null
}
