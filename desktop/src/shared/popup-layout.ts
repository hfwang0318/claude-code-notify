export interface PopupWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface PopupAnchor {
  x: number
  /** Bottom edge in screen coordinates; keeps the popup glued to the taskbar. */
  bottom: number
}

export const POPUP_MARGIN = 22
export const POPUP_FALLBACK_HEIGHT = 540

/**
 * Resolve a popup's top-left position.
 *
 * A saved anchor is a bottom edge, not a top-left corner. Persisting the top
 * left made a newly-created 540px window inherit the top of an older, taller
 * window; resizing kept the wrong (too high) bottom, which is the Windows
 * "popup drifts upward" bug. Bottom-anchored positions are stable across
 * content height changes and window recreation.
 */
export function resolvePopupBounds(input: {
  width: number
  height: number
  area: PopupWorkArea
  anchor: PopupAnchor | null
  margin?: number
}): { x: number; y: number } {
  const margin = input.margin ?? POPUP_MARGIN
  const right = input.area.x + input.area.width - input.width - margin
  const bottom = input.area.y + input.area.height - input.height - margin
  const anchor = input.anchor
  const anchorUsable =
    anchor !== null &&
    Number.isFinite(anchor.x) &&
    Number.isFinite(anchor.bottom) &&
    anchor.bottom > input.area.y &&
    anchor.bottom <= input.area.y + input.area.height

  if (!anchorUsable) {
    return {
      x: Math.round(Math.max(input.area.x + margin, right)),
      y: Math.round(Math.max(input.area.y + margin, bottom))
    }
  }

  return {
    x: Math.round(
      Math.min(
        Math.max(anchor.x, input.area.x + margin),
        input.area.x + input.area.width - input.width - margin
      )
    ),
    y: Math.round(Math.max(input.area.y + margin, anchor.bottom - input.height))
  }
}

/** Convert the legacy top-left setting into the new bottom-edge anchor. */
export function anchorFromLegacyPosition(
  position: { x: number; y: number },
  previousHeight?: number
): PopupAnchor {
  return {
    x: position.x,
    bottom: position.y + (previousHeight ?? POPUP_FALLBACK_HEIGHT)
  }
}
