import { describe, expect, it } from 'vitest'
import { approvalFromPayload } from './protocol'

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
