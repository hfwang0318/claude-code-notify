import type { LogEntry } from '../../shared/types'

/**
 * 计算相对上一次 tail 日志新增的条数。
 *
 * 日志在 store 中最多保留 800 条，长度会封顶，因此不能只比较 length。
 * 以最后一条日志的 id 作为 tail 标识：找到旧 tail 在新数组中的位置，
 * 其后的条目即为新增。找不到旧 tail（例如清空或整体滚动）时退化为按长度计算。
 */
export function countNewLogs(previousTailId: string | null, logs: LogEntry[]): number {
  if (logs.length === 0) return 0
  if (!previousTailId) return logs.length
  const tailIndex = logs.findIndex((entry) => entry.id === previousTailId)
  if (tailIndex < 0) return logs.length
  return logs.length - tailIndex - 1
}

/** 取日志数组的 tail id，空数组返回 null。 */
export function tailLogId(logs: LogEntry[]): string | null {
  return logs.length > 0 ? logs[logs.length - 1].id : null
}
