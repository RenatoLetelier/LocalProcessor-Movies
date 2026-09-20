import type { FastifyPluginAsync } from 'fastify'
import { LOG_CATEGORIES, LOG_LEVELS, type LogCategory, type LogLevel } from '@shared/model'
import type { ServerContext } from '../context'
import { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from '../db/repositories/logs'
import { formatEntry } from '../logging/format'

interface LogsQuerystring {
  level?: LogLevel
  category?: LogCategory
  jobId?: string
  titleId?: string
  q?: string
  before?: number
  limit?: number
  format?: 'json' | 'text'
}

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    level: { type: 'string', enum: LOG_LEVELS },
    category: { type: 'string', enum: LOG_CATEGORIES },
    jobId: { type: 'string' },
    titleId: { type: 'string' },
    q: { type: 'string' },
    before: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LOG_LIMIT },
    format: { type: 'string', enum: ['json', 'text'] }
  }
} as const

// GET /logs: the most recent entries that match, oldest first. ?before=<id>
// pages towards the past; ?format=text returns the same lines app.log holds.
export const logsRoutes: FastifyPluginAsync<{ context: ServerContext }> = async (app, { context }) => {
  app.get<{ Querystring: LogsQuerystring }>('/logs', { schema: { querystring: querySchema } }, async (request, reply) => {
    const { format, ...query } = request.query
    const entries = context.repos.logs.list({ ...query, limit: query.limit ?? DEFAULT_LOG_LIMIT })
    if (format === 'text') {
      return reply.type('text/plain; charset=utf-8').send(entries.map(formatEntry).join('\n') + (entries.length ? '\n' : ''))
    }
    return entries
  })
}
