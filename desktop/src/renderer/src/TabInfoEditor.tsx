import { useState } from 'react'
import type { TabInfoItem } from '../../shared/types'
import {
  availableTabItems,
  moveTabInfoItem,
  tabInfoLabel,
  type TabInfoDropZone
} from '../../shared/tab-info'

interface Props {
  prefix: TabInfoItem[]
  suffix: TabInfoItem[]
  onChange: (prefix: TabInfoItem[], suffix: TabInfoItem[]) => void
}

interface PillProps {
  item: TabInfoItem
  zone: 'pool' | 'prefix' | 'suffix'
  index?: number
  dragging: TabInfoItem | null
  onDragStart: (item: TabInfoItem) => void
  onDragEnd: () => void
  onDrop: (zone: TabInfoDropZone, index?: number) => void
  onRemove?: (item: TabInfoItem) => void
}

function Pill({
  item,
  zone,
  index,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onRemove
}: PillProps): React.JSX.Element {
  return (
    <span
      className={`tab-info-pill ${dragging === item ? 'dragging' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', item)
        onDragStart(item)
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (zone === 'pool') return
        event.preventDefault()
      }}
      onDrop={(event) => {
        if (zone === 'pool') return
        event.preventDefault()
        event.stopPropagation()
        onDrop(zone, index)
      }}
      role="button"
      tabIndex={0}
      aria-label={`${tabInfoLabel(item)}，可拖拽`}
    >
      {tabInfoLabel(item)}
      {onRemove ? (
        <button
          type="button"
          className="tab-info-remove"
          aria-label={`移除${tabInfoLabel(item)}`}
          onClick={(event) => {
            event.stopPropagation()
            onRemove(item)
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  )
}

export default function TabInfoEditor({
  prefix,
  suffix,
  onChange
}: Props): React.JSX.Element {
  const [dragging, setDragging] = useState<TabInfoItem | null>(null)
  const [dropTarget, setDropTarget] = useState<string>('')

  const pool = availableTabItems(prefix, suffix)

  const drop = (zone: TabInfoDropZone, index?: number): void => {
    setDropTarget('')
    if (!dragging) return
    const next = moveTabInfoItem(prefix, suffix, dragging, zone, index)
    setDragging(null)
    onChange(next.prefix, next.suffix)
  }

  const remove = (item: TabInfoItem): void => {
    const next = moveTabInfoItem(prefix, suffix, item, 'pool')
    onChange(next.prefix, next.suffix)
  }

  const zoneClass = (zone: 'pool' | 'prefix' | 'suffix'): string =>
    `tab-info-zone ${zone === 'pool' ? 'tab-info-pool' : ''} ${
      dropTarget === zone ? 'drag-over' : ''
    }`

  return (
    <div className="tab-info-editor">
      <div className="tab-info-caption">可选信息项</div>
      <div
        className={zoneClass('pool')}
        onDragOver={(event) => {
          event.preventDefault()
          setDropTarget('pool')
        }}
        onDragLeave={() => setDropTarget('')}
        onDrop={(event) => {
          event.preventDefault()
          drop('pool')
        }}
      >
        {pool.length === 0 ? (
          <span className="tab-info-hint">全部已选择；把胶囊拖回这里可移除</span>
        ) : (
          pool.map((item) => (
            <Pill
              key={item}
              item={item}
              zone="pool"
              dragging={dragging}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              onDrop={drop}
            />
          ))
        )}
      </div>

      <div className="tab-info-caption">前缀</div>
      <div
        className={zoneClass('prefix')}
        onDragOver={(event) => {
          event.preventDefault()
          setDropTarget('prefix')
        }}
        onDragLeave={() => setDropTarget('')}
        onDrop={(event) => {
          event.preventDefault()
          drop('prefix')
        }}
      >
        {prefix.length === 0 ? (
          <span className="tab-info-hint">拖拽胶囊到这里</span>
        ) : (
          prefix.map((item, index) => (
            <Pill
              key={item}
              item={item}
              zone="prefix"
              index={index}
              dragging={dragging}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              onDrop={drop}
              onRemove={remove}
            />
          ))
        )}
      </div>

      <div className="tab-info-caption">后缀</div>
      <div
        className={zoneClass('suffix')}
        onDragOver={(event) => {
          event.preventDefault()
          setDropTarget('suffix')
        }}
        onDragLeave={() => setDropTarget('')}
        onDrop={(event) => {
          event.preventDefault()
          drop('suffix')
        }}
      >
        {suffix.length === 0 ? (
          <span className="tab-info-hint">拖拽胶囊到这里</span>
        ) : (
          suffix.map((item, index) => (
            <Pill
              key={item}
              item={item}
              zone="suffix"
              index={index}
              dragging={dragging}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              onDrop={drop}
              onRemove={remove}
            />
          ))
        )}
      </div>
    </div>
  )
}
