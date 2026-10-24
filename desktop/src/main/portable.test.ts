import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectPortableBuild } from './portable'

describe('portable build detection', () => {
  it('recognizes the portable env marker', () => {
    expect(detectPortableBuild('/tmp/app.exe', { PORTABLE_EXECUTABLE_DIR: '/tmp' })).toBe(true)
  })

  it('recognizes RUN-ME.bat and portable.marker next to the executable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-notify-portable-'))
    try {
      writeFileSync(join(directory, 'RUN-ME.bat'), '@echo off')
      expect(detectPortableBuild(join(directory, 'Claude Notify.exe'))).toBe(true)
      rmSync(join(directory, 'RUN-ME.bat'))
      writeFileSync(join(directory, 'portable.marker'), 'portable')
      expect(detectPortableBuild(join(directory, 'Claude Notify.exe'))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not classify an installed executable as portable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-notify-installed-'))
    try {
      expect(detectPortableBuild(join(directory, 'Claude Notify.exe'), {})).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
