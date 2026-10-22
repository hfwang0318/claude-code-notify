import { describe, expect, it } from 'vitest'
import { FONT_SCALES, resolveFontScale } from './typography'

describe('typography', () => {
  it('maps the four size presets to stable scales', () => {
    expect(FONT_SCALES.small).toBeLessThan(1)
    expect(FONT_SCALES.normal).toBe(1)
    expect(FONT_SCALES.large).toBeGreaterThan(1)
    expect(FONT_SCALES.xlarge).toBeGreaterThan(FONT_SCALES.large)
  })

  it('falls back to normal for missing or invalid sizes', () => {
    expect(resolveFontScale(undefined)).toBe(1)
    expect(resolveFontScale('large' as never)).toBe(1.06)
  })
})
