import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry } from '../../shared/types'
import { LEVEL_LABEL, formatTime } from './format'
import { api } from './api'
import { countNewLogs, tailLogId } from './log-delta'

interface Props {
  logs: LogEntry[]
}

const LEVEL_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'notify', label: '审批' },
  { id: 'allow', label: '允许' },
  { id: 'deny', label: '拒绝' },
  { id: 'timeout', label: '超时' },
  { id: 'cancelled', label: '终端' },
  { id: 'warn', label: '警告' },
  { id: 'error', label: '错误' },
  { id: 'deploy', label: '部署' }
]

function LogPanel({ logs }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [stick, setStick] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const lastTail = useRef<string | null>(tailLogId(logs))

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return logs.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false
      if (!text) return true
      return `${entry.level} ${entry.text}`.toLowerCase().includes(text)
    })
  }, [level, logs, query])

  const scrollToBottom = (): void => {
    const body = bodyRef.current
    if (!body) return
    body.scrollTop = body.scrollHeight
    setNewCount(0)
  }

  useEffect(() => {
    // 不能只比较 length：store 最多保留 800 条，达到上限后 length 不再变化。
    const added = countNewLogs(lastTail.current, logs)
    lastTail.current = tailLogId(logs)
    if (added <= 0) return
    if (stick) scrollToBottom()
    else setNewCount((value) => value + added)
  }, [logs, stick])

  const onScroll = (): void => {
    const body = bodyRef.current
    if (!body) return
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 36
    setStick(nearBottom)
    if (nearBottom) setNewCount(0)
  }

  const copyVisible = (): void => {
    void api.copy(
      filtered
        .map((entry) => `${formatTime(entry.ts)} ${entry.level} ${entry.text}`)
        .join('\n')
    )
  }

  return (
    <div className="logs">
      <div className="panel-toolbar">
        <input
          className="search-input"
          value={query}
          placeholder="搜索日志…"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索日志"
        />
        <div className="filter-chips" role="group" aria-label="日志级别">
          {LEVEL_FILTERS.map((filter) => (
            <button
              key={filter.id}
              className={level === filter.id ? 'chip active' : 'chip'}
              aria-pressed={level === filter.id}
              onClick={() => setLevel(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="panel-toolbar-actions">
          <button
            className={`btn subtle compact ${stick ? 'active' : ''}`}
            onClick={() => {
              setStick((value) => !value)
              if (!stick) scrollToBottom()
            }}
            title={stick ? '新日志自动滚动到底部' : '已暂停自动滚动'}
          >
            {stick ? '跟随' : '暂停'}
          </button>
          <button className="btn subtle compact" onClick={copyVisible}>
            复制
          </button>
          <button className="btn subtle compact" onClick={() => void api.logsClear()}>
            清空
          </button>
          <button className="btn subtle compact" onClick={() => void api.openLogFile()}>
            打开文件
          </button>
          <button className="btn subtle compact" onClick={() => void api.openLogs()}>
            目录
          </button>
        </div>
      </div>

      <div className="log-body" ref={bodyRef} onScroll={onScroll} role="log" aria-live="polite">
        {filtered.length === 0 ? (
          <div className="log-empty">
            {logs.length === 0 ? '暂无日志。启动服务或推送一条通知。' : '没有匹配的日志。'}
          </div>
        ) : (
          filtered.map((entry) => (
            <div className={`log-line level-${entry.level}`} key={entry.id}>
              <span className="log-time">{formatTime(entry.ts)}</span>
              <span className="log-level">{LEVEL_LABEL[entry.level] ?? entry.level}</span>
              <span className="log-message" title={entry.text}>
                {entry.text}
              </span>
            </div>
          ))
        )}
      </div>

      {!stick && newCount > 0 ? (
        <button className="new-logs" onClick={scrollToBottom}>
          {newCount} 条新日志 ↓
        </button>
      ) : null}
      <div className="log-footer">
        <span>
          {filtered.length} / {logs.length} 条
        </span>
        <span>日志文件超过 5 MB 自动轮转</span>
      </div>
    </div>
  )
}

export default memo(LogPanel)
