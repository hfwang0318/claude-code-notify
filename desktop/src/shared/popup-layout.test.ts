import { describe, expect, it } from 'vitest'
import {
  anchorFromLegacyPosition,
  resolvePopupBounds,
  type PopupWorkArea
} from './popup-layout'

const display: PopupWorkArea = { x: 0, y: 0, width: 1920, height: 1040 }

describe('popup layout', () => {
  it('places a new popup at the bottom-right corner', () => {
    expect(
      resolvePopupBounds({ width: 560, height: 540, area: display, anchor: null })
    ).toEqual({ x: 1338, y: 478 })
  })

  it('keeps the saved bottom edge when the popup grows or shrinks', () => {
    const anchor = { x: 1200, bottom: 1000 }
    expect(resolvePopupBounds({ width: 560, height: 700, area: display, anchor })).toEqual({
      x: 1200,
      y: 300
    })
    expect(resolvePopupBounds({ width: 560, height: 400, area: display, anchor })).toEqual({
      x: 1200,
      y: 600
    })
  })

  it('does not reuse a saved anchor that is no longer on screen', () => {
    expect(
      resolvePopupBounds({
        width: 560,
        height: 540,
        area: display,
        anchor: { x: 1200, bottom: 1200 }
      })
    ).toEqual({ x: 1338, y: 478 })
  })

  it('clamps a saved anchor inside the work area', () => {
    expect(
      resolvePopupBounds({
        width: 560,
        height: 540,
        area: display,
        anchor: { x: 5000, bottom: 1000 }
      })
    ).toEqual({ x: 1338, y: 460 })
  })

  it('migrates the old top-left position using its saved height', () => {
    expect(anchorFromLegacyPosition({ x: 100, y: 200 }, 736)).toEqual({
      x: 100,
      bottom: 936
    })
    expect(anchorFromLegacyPosition({ x: 100, y: 200 }, undefined)).toEqual({
      x: 100,
      bottom: 740
    })
  })
})
