import type { TabInfoItem } from './types'

export interface TabInfoDefinition {
  id: TabInfoItem
  label: string
}

/** Order here is the order of the capsule pool in the deploy UI. */
export const TAB_INFO_ITEMS: readonly TabInfoDefinition[] = [
  { id: 'project', label: '项目名' },
  { id: 'branch', label: '分支' },
  { id: 'shortId', label: '会话短码' },
  { id: 'origin', label: '来源' },
  { id: 'terminal', label: '终端' },
  { id: 'cwd', label: '工作目录' },
  { id: 'task', label: '当前任务' }
]

const TAB_INFO_IDS = new Set<TabInfoItem>(TAB_INFO_ITEMS.map((item) => item.id))

export function isTabInfoItem(value: unknown): value is TabInfoItem {
  return typeof value === 'string' && TAB_INFO_IDS.has(value as TabInfoItem)
}

/** Drop unknown/duplicate ids, preserving first occurrence order. */
export function sanitizeTabItems(value: unknown): TabInfoItem[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<TabInfoItem>()
  const output: TabInfoItem[] = []
  for (const item of value) {
    if (!isTabInfoItem(item) || seen.has(item)) continue
    seen.add(item)
    output.push(item)
  }
  return output
}

export function defaultTabPrefix(): TabInfoItem[] {
  return []
}

export function defaultTabSuffix(): TabInfoItem[] {
  return []
}

export function tabInfoLabel(item: TabInfoItem): string {
  return TAB_INFO_ITEMS.find((entry) => entry.id === item)?.label || item
}

export type TabInfoDropZone = 'pool' | 'prefix' | 'suffix'

export interface TabInfoLayout {
  prefix: TabInfoItem[]
  suffix: TabInfoItem[]
}

/**
 * Move one capsule between the pool / prefix / suffix.
 *
 * `index` is the insertion index in the target zone *before* the dragged item
 * is removed; same-zone reorders account for the removal.
 */
export function moveTabInfoItem(
  prefix: TabInfoItem[],
  suffix: TabInfoItem[],
  item: TabInfoItem,
  target: TabInfoDropZone,
  index?: number
): TabInfoLayout {
  const nextPrefix = prefix.filter((entry) => entry !== item)
  const nextSuffix = suffix.filter((entry) => entry !== item)
  if (target === 'pool') return { prefix: nextPrefix, suffix: nextSuffix }

  const source = target === 'prefix' ? prefix : suffix
  const sourceIndex = source.indexOf(item)
  const targetList = target === 'prefix' ? nextPrefix : nextSuffix
  let insertion = index ?? targetList.length
  if (sourceIndex >= 0 && sourceIndex < insertion) insertion -= 1
  insertion = Math.max(0, Math.min(insertion, targetList.length))
  targetList.splice(insertion, 0, item)
  return target === 'prefix'
    ? { prefix: targetList, suffix: nextSuffix }
    : { prefix: nextPrefix, suffix: targetList }
}

export function availableTabItems(
  prefix: TabInfoItem[],
  suffix: TabInfoItem[]
): TabInfoItem[] {
  const selected = new Set([...prefix, ...suffix])
  return TAB_INFO_ITEMS.map((entry) => entry.id).filter((id) => !selected.has(id))
}
