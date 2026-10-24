import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const python = process.platform === 'win32' ? 'python' : 'python3'
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0
const hookPath = join(process.cwd(), 'resources', 'hooks', 'claude_approval_hook.py')
const maybe = hasPython ? it : it.skip

describe('hook tool-use correlation journal', () => {
  maybe('claims a recorded PreToolUse exactly once', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-notify-correlation-'))
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("approval_hook", ${JSON.stringify(hookPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
tool_input = {"command": "git status"}
hook_input = {"session_id": "s1", "prompt_id": "p1", "tool_name": "Bash", "tool_use_id": "toolu_1", "transcript_path": "/tmp/t.jsonl"}
first = module.record_pretooluse(hook_input, tool_input)
claim = module.claim_pretooluse(hook_input, tool_input)
second = module.claim_pretooluse(hook_input, tool_input)
print(json.dumps({"recorded": bool(first), "claim": claim, "second": second}))
`
    try {
      const result = spawnSync(python, ['-c', script], {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_NOTIFY_DATA_DIR: dataDir }
      })
      expect(result.status, result.stderr).toBe(0)
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}')
      expect(parsed.recorded).toBe(true)
      expect(parsed.claim).toMatchObject({
        tool_use_id: 'toolu_1',
        transcript_path: '/tmp/t.jsonl'
      })
      expect(parsed.second).toBeNull()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 20000)
})
