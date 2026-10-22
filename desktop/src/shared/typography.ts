import type { FontSize, FontStyle } from './types'

export const FONT_STYLE_LABELS: Record<FontStyle, string> = {
  system: '系统',
  rounded: '圆体',
  serif: '衬线',
  mono: '等宽'
}

export const FONT_SIZE_LABELS: Record<FontSize, string> = {
  small: '小',
  normal: '标准',
  large: '大',
  xlarge: '特大'
}

export const FONT_SCALES: Record<FontSize, number> = {
  small: 0.92,
  normal: 1,
  large: 1.06,
  xlarge: 1.12
}

export function resolveFontScale(size: FontSize | undefined): number {
  return FONT_SCALES[size || 'normal'] || 1
}
