import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRecord } from '../shared/types'
import { appDataDir, ensureDataDir } from './config'

const MAX_MEMORY = 300
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LINES_AFTER_COMPACT = 1500

export function historyFilePath(): string {
  return join(appDataDir(), 'history.jsonl')
}

function parseLine(line: string): ApprovalRecord | null {
  if (!line.trim()) return null
  try {
    const record = JSON.parse(line) as ApprovalRecord
    if (!record || typeof record.id !== 'string' || typeof record.ts !== 'number') return null
    return record
  } catch {
    return null
  }
}

function parseRecords(text: string): ApprovalRecord[] {
  return text
    .split('\n')
    .map(parseLine)
    .filter((record): record is ApprovalRecord => record !== null)
}

function readAllStrict(): ApprovalRecord[] {
  const file = historyFilePath()
  if (!existsSync(file)) return []
  return parseRecords(readFileSync(file, 'utf-8'))
}

function readAll(): ApprovalRecord[] {
  try {
    return readAllStrict()
  } catch {
    return []
  }
}

function compact(): void {
  const file = historyFilePath()
  let records: ApprovalRecord[]
  try {
    records = readAllStrict()
  } catch {
    // Never replace an unreadable history with an empty file.
    return
  }
  const kept = records.slice(-MAX_LINES_AFTER_COMPACT)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, kept.map((record) => `${JSON.stringify(record)}\n`).join(''), {
    encoding: 'utf-8',
    mode: 0o600
  })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // ignore
  }
  try {
    renameSync(temp, file)
  } catch {
    copyFileSync(temp, file)
    try {
      unlinkSync(temp)
    } catch {
      // best-effort cleanup
    }
  }
}

export class HistoryStore {
  private records: ApprovalRecord[] = []

  load(): ApprovalRecord[] {
    this.records = readAll().slice(-MAX_MEMORY).reverse()
    return this.records
  }

  get(): ApprovalRecord[] {
    return this.records
  }

  append(record: ApprovalRecord): void {
    this.records = [record, ...this.records].slice(0, MAX_MEMORY)
    ensureDataDir()
    const file = historyFilePath()
    try {
      appendFileSync(file, `${JSON.stringify(record)}\n`, {
        encoding: 'utf-8',
        mode: 0o600
      })
      try {
        chmodSync(file, 0o600)
      } catch {
        // ignore
      }
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) compact()
    } catch {
      // history must never break the approval flow
    }
  }

  clear(): void {
    this.records = []
    ensureDataDir()
    try {
      writeFileSync(historyFilePath(), '', { encoding: 'utf-8', mode: 0o600 })
    } catch {
      // ignore
    }
  }

  exportJson(target: string): number {
    let records: ApprovalRecord[]
    try {
      records = readAllStrict()
    } catch {
      records = []
    }
    if (records.length === 0 && this.records.length > 0) {
      records = [...this.records].reverse()
    }
    writeFileSync(target, `${JSON.stringify(records, null, 2)}\n`, 'utf-8')
    return records.length
  }

  exportCsv(target: string): number {
    const header = [
      'time',
      'session',
      'origin',
      'project',
      'tool',
      'decision',
      'source',
      'latency_ms',
      'risk',
      'command'
    ]
    const escape = (value: unknown): string => {
      const text = String(value ?? '')
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    // Export the complete on-disk history (~1500 records after compaction),
    // not just the 300 records kept in memory for the UI.
    let records: ApprovalRecord[]
    try {
      records = readAllStrict()
    } catch {
      records = []
    }
    // readAllStrict returns [] for a missing/empty file as well. In that case
    // retain the old best-effort behaviour and export whatever is in memory.
    if (records.length === 0 && this.records.length > 0) {
      records = [...this.records].reverse()
    }
    const rows = records.map((record) =>
      [
        new Date(record.ts).toISOString(),
        record.sessionLabel,
        record.origin,
        record.project,
        record.tool,
        record.decision,
        record.source,
        record.latencyMs,
        record.risk,
        record.command
      ]
        .map(escape)
        .join(',')
    )
    writeFileSync(target, `${[header.join(','), ...rows].join('\n')}\n`, 'utf-8')
    return records.length
  }
}
