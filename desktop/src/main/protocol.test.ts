import { describe, expect, it } from 'vitest'
import { approvalFromPayload, buildNotification } from './protocol'

describe('approvalFromPayload', () => {
  it('preserves multi-session identity, terminal metadata and risk', () => {
    const item = approvalFromPayload(
      {
        request_id: 'req_1',
        session_id: 'session-a',
        prompt_id: 'prompt-1',
        tool_use_id: 'tool-1',
        origin: 'prod-api',
        tty: 'ttys004',
        terminal: 'iTerm2',
        cwd: '/work/backend-api',
        task: '修复登录跳转失败',
        branch: 'feat/login',
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin main' },
        timeout_seconds: 60
      },
      'apr_1',
      1000,
      60
    )
    expect(item.sessionKey).toBe('prod-api:session-a')
    expect(item.sessionLabel).toContain('backend-api')
    expect(item.tty).toBe('ttys004')
    expect(item.terminal).toBe('iTerm2')
    expect(item.task).toBe('修复登录跳转失败')
    expect(item.branch).toBe('feat/login')
    expect(item.promptId).toBe('prompt-1')
    expect(item.risk.level).toBe('high')
    expect(item.correlation).toBe('exact')
    expect(item.timeoutAt).toBe(61000)
  })

  it('falls back to unmatched when the hook could not correlate a tool use', () => {
    const item = approvalFromPayload(
      {
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        correlation: 'unmatched'
      },
      'apr_2',
      1000,
      30
    )
    expect(item.correlation).toBe('unmatched')
    expect(item.sessionKey).toBe('本机:s')
  })
})


describe('buildNotification', () => {
  it('names Stop notifications as completed, not waiting for approval', () => {
    const notification = buildNotification({
      session_id: 'session-a',
      origin: '本机',
      cwd: '/work/backend-api',
      notification_type: 'Stop'
    })
    expect(notification.title).toContain('已完成')
    expect(notification.title).not.toContain('等待审批')
    expect(notification.body).toContain('完成当前回合')
  })

  it('keeps permission notifications labeled as waiting for approval', () => {
    const notification = buildNotification({
      session_id: 'session-a',
      cwd: '/work/backend-api',
      notification_type: 'permission_request'
    })
    expect(notification.title).toContain('等待审批')
  })
})
