import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { LOG_LEVELS, type LogCategory, type LogEntry, type LogLevel } from '@shared/model'
import { asRows } from './common'

export interface NewLogEntry {
  ts: string
  level: LogLevel
  category: LogCategory
  message: string
  jobId?: string | null
  titleId?: string | null
  context?: Record<string, unknown> | null
}

export interface LogsQuery {
  // Minimum level: 'info' returns info, warn and error
  level?: LogLevel
  category?: LogCategory
  jobId?: string
  titleId?: string
  // Case-insensitive substring of the message or the context
  q?: string
  // Entries older than this id (pagination towards the past)
  before?: number
  limit?: number
}

export interface LogRetention {
  // Entries older than this are dropped
  maxAgeDays: number
  // Entries of jobs other than the most recent N are dropped
  maxJobs: number
  // Hard cap on rows, whatever their age
  maxEntries: number
}

export interface LogsRepository {
  insert(entry: NewLogEntry): LogEntry
  // The most recent entries matching the query, oldest first
  list(query?: LogsQuery): LogEntry[]
  count(): number
  // Applies the retention rules; returns how many rows were removed
  prune(retention: LogRetention, now?: Date): number
}

interface LogRow {
  id: number
  ts: string
  level: LogLevel
  category: LogCategory
  message: string
  job_id: string | null
  title_id: string | null
  context: string | null
}

export const DEFAULT_LOG_LIMIT = 200
export const MAX_LOG_LIMIT = 1000

export function createLogsRepository(db: DatabaseSync): LogsRepository {
  const insert = db.prepare(`
    INSERT INTO logs (ts, level, category, message, job_id, title_id, context)
    VALUES (@ts, @level, @category, @message, @job_id, @title_id, @context)
  `)
  const selectById = db.prepare('SELECT * FROM logs WHERE id = ?')
  const countAll = db.prepare('SELECT count(*) AS n FROM logs')

  const toEntry = (row: LogRow): LogEntry => ({
    ...row,
    context: row.context ? (JSON.parse(row.context) as Record<string, unknown>) : null
  })

  return {
    insert(entry) {
      const { lastInsertRowid } = insert.run({
        ts: entry.ts,
        level: entry.level,
        category: entry.category,
        message: entry.message,
        job_id: entry.jobId ?? null,
        title_id: entry.titleId ?? null,
        context: entry.context ? JSON.stringify(entry.context) : null
      })
      return toEntry(selectById.get(lastInsertRowid) as unknown as LogRow)
    },

    list(query = {}) {
      const where: string[] = []
      const params: SQLInputValue[] = []
      if (query.level && query.level !== 'debug') {
        const allowed = LOG_LEVELS.slice(LOG_LEVELS.indexOf(query.level))
        where.push(`level IN (${allowed.map(() => '?').join(', ')})`)
        params.push(...allowed)
      }
      if (query.category) {
        where.push('category = ?')
        params.push(query.category)
      }
      if (query.jobId) {
        where.push('job_id = ?')
        params.push(query.jobId)
      }
      if (query.titleId) {
        where.push('title_id = ?')
        params.push(query.titleId)
      }
      if (query.q) {
        where.push("(message LIKE ? ESCAPE '\\' OR context LIKE ? ESCAPE '\\')")
        const like = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`
        params.push(like, like)
      }
      if (query.before !== undefined) {
        where.push('id < ?')
        params.push(query.before)
      }
      const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LOG_LIMIT), MAX_LOG_LIMIT)
      const sql = `SELECT * FROM logs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
      return asRows<LogRow>(db.prepare(sql).all(...params, limit))
        .map(toEntry)
        .reverse()
    },

    count: () => (countAll.get() as { n: number }).n,

    prune(retention, now = new Date()) {
      const cutoff = new Date(now.getTime() - retention.maxAgeDays * 86_400_000).toISOString()
      let removed = Number(db.prepare('DELETE FROM logs WHERE ts < ?').run(cutoff).changes)
      // Jobs ranked by their latest entry: everything from older jobs goes
      removed += Number(
        db
          .prepare(
            `DELETE FROM logs WHERE job_id IS NOT NULL AND job_id NOT IN (
               SELECT job_id FROM (SELECT job_id, MAX(id) AS last FROM logs WHERE job_id IS NOT NULL GROUP BY job_id ORDER BY last DESC LIMIT ?)
             )`
          )
          .run(retention.maxJobs).changes
      )
      removed += Number(db.prepare('DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)').run(retention.maxEntries).changes)
      return removed
    }
  }
}
