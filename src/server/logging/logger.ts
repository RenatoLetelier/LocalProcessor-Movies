import type { LogCategory, LogEntry, LogLevel } from '@shared/model'
import type { LogsRepository, NewLogEntry } from '../db/repositories/logs'
import type { ServerEvents } from '../jobs/events'
import type { FileSink } from './file-sink'
import { formatEntry } from './format'

export interface LogDetail {
  jobId?: string | null
  titleId?: string | null
  context?: Record<string, unknown> | null
}

export interface LoggerOptions {
  file?: FileSink
  // Mirrors every line somewhere else (the console in development)
  echo?: (line: string) => void
  // Rows kept in the logs table; the oldest are dropped past this
  maxEntries?: number
  // Keeps nothing (tests, CLI runs)
  discard?: boolean
}

export const DEFAULT_MAX_LOG_ENTRIES = 50_000
const PRUNE_EVERY = 500
// Entries logged before the database is open (startup) wait here
const MAX_PENDING = 1000

// The action log. Every entry goes to the text file at once (even before the
// database exists) and to the logs table + WebSocket once a store is attached.
export class AppLogger {
  private store?: LogsRepository
  private events?: ServerEvents
  private readonly pending: NewLogEntry[] = []
  private sincePrune = 0

  constructor(private readonly options: LoggerOptions = {}) {}

  static silent(): AppLogger {
    return new AppLogger({ discard: true })
  }

  attachStore(store: LogsRepository, events?: ServerEvents): void {
    this.store = store
    this.events = events
    for (const entry of this.pending.splice(0)) this.persist(entry)
    this.prune()
  }

  log(level: LogLevel, category: LogCategory, message: string, detail: LogDetail = {}): void {
    if (this.options.discard) return
    const entry: NewLogEntry = {
      ts: new Date().toISOString(),
      level,
      category,
      message,
      jobId: detail.jobId ?? null,
      titleId: detail.titleId ?? null,
      context: serializable(detail.context)
    }
    const line = formatEntry({ ...entry, job_id: entry.jobId ?? null, title_id: entry.titleId ?? null, context: entry.context ?? null })
    this.options.file?.write(line)
    this.options.echo?.(line)
    if (this.store) this.persist(entry)
    else {
      this.pending.push(entry)
      if (this.pending.length > MAX_PENDING) this.pending.shift()
    }
  }

  debug(category: LogCategory, message: string, detail?: LogDetail): void {
    this.log('debug', category, message, detail)
  }

  info(category: LogCategory, message: string, detail?: LogDetail): void {
    this.log('info', category, message, detail)
  }

  warn(category: LogCategory, message: string, detail?: LogDetail): void {
    this.log('warn', category, message, detail)
  }

  error(category: LogCategory, message: string, detail?: LogDetail): void {
    this.log('error', category, message, detail)
  }

  private persist(entry: NewLogEntry): LogEntry | undefined {
    try {
      const stored = this.store!.insert(entry)
      this.events?.emit({ type: 'log.entry', entry: stored })
      if (++this.sincePrune >= PRUNE_EVERY) this.prune()
      return stored
    } catch (error) {
      this.options.file?.write(formatEntry({ ...entry, job_id: null, title_id: null, level: 'error', category: 'app', message: `No se pudo guardar el log en la base de datos: ${String(error)}`, context: null }))
      return undefined
    }
  }

  private prune(): void {
    this.sincePrune = 0
    this.store?.prune(this.options.maxEntries ?? DEFAULT_MAX_LOG_ENTRIES)
  }
}

// What a thrown value contributes to an entry's context
export function errorContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra = Object.fromEntries(Object.entries(error).filter(([key]) => !['message', 'stack', 'name'].includes(key)))
    return { error: error.message, errorType: error.name, ...(error.stack ? { stack: error.stack } : {}), ...extra }
  }
  return { error: String(error) }
}

function serializable(context: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!context) return null
  try {
    return JSON.parse(JSON.stringify(context)) as Record<string, unknown>
  } catch {
    return { error: 'contexto no serializable' }
  }
}
