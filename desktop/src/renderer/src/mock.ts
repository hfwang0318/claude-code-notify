import type { AppState } from '../../shared/types'

const now = Date.now()

export const mockState: AppState = {
  app: { version: '0.1.0-spike', platform: 'darwin' },
  server: {
    listening: true,
    port: 18765,
    token: 'cn_live_9f4c2b7a8e1d6f3a5c0b9e8d7a6f5c4b3a2e1d0c',
    localIp: '192.168.1.20',
    notified: 18
  },
  pending: [],
  expired: null,
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
      text: '通知 · 会话 7f3a · 等待输入 · 已推送系统通知'
    },
    {
      id: 'l4',
      ts: now - 43000,
      level: 'allow',
      text: 'Bash · git status · 弹窗允许 · 2.6s'
    },
    {
      id: 'l5',
      ts: now - 21000,
      level: 'deny',
      text: 'Edit · src/app.py · 拒绝并附原因 · 焦点回到终端'
    }
  ],
  deploy: {
    status: 'deployed',
    host: 'deploy@192.168.1.20:22',
    hooks: 2,
    message: '上次成功 16:15'
  },
  prefs: {
    position: 'cursor',
    mode: 'popup',
    timeoutSec: 240
  },
  toast: null
}
