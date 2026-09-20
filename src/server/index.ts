import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import type { ServerContext } from './context'
import { checkAccess } from './auth'
import { HttpError } from './errors'
import { errorContext } from './logging/logger'
import { healthRoutes } from './routes/health'
import { configRoutes } from './routes/config'
import { titlesRoutes } from './routes/titles'
import { jobsRoutes } from './routes/jobs'
import { systemRoutes } from './routes/system'
import { logsRoutes } from './routes/logs'

declare module 'fastify' {
  interface FastifyRequest {
    // Why a request failed, for the api log entry written on response
    failure: string | null
  }
}

export type { ServerContext } from './context'

export interface ServerOptions {
  host: string
  port: number
  version: string
  context: ServerContext
  // Browser origins allowed to call the API (the Electron renderer). Non-browser
  // clients (curl, Node) send no Origin header and are unaffected by CORS.
  allowedOrigins: string[]
  logLevel?: string
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  501: 'Not Implemented'
}

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: opts.logLevel ?? 'info' },
    // Reject unknown body keys instead of silently dropping them (Fastify default)
    ajv: { customOptions: { removeAdditional: false } }
  })

  const log = opts.context.log
  app.decorateRequest('failure', null)

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      request.failure = error.message
      return reply
        .code(error.statusCode)
        .send({ statusCode: error.statusCode, error: STATUS_TEXT[error.statusCode] ?? 'Error', message: error.message, ...error.extra })
    }
    const fastifyError = error as FastifyError
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      request.failure = fastifyError.message
      return reply
        .code(fastifyError.statusCode)
        .send({ statusCode: fastifyError.statusCode, error: fastifyError.name, message: fastifyError.message })
    }
    request.log.error(error)
    const message = error instanceof Error ? error.message : String(error)
    request.failure = message
    log.error('api', `Error interno en ${request.method} ${redactUrl(request.url)}`, { context: errorContext(error) })
    return reply.code(500).send({ statusCode: 500, error: 'Internal Server Error', message })
  })

  // Every request that changes something, and every rejected one, leaves an entry
  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode
    const readOnly = request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS'
    if (readOnly && status < 400) return
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
    const url = redactUrl(request.url)
    const { id } = (request.params ?? {}) as { id?: string }
    log.log(level, 'api', `${request.method} ${url} → ${status}${request.failure ? `: ${request.failure}` : ''}`, {
      titleId: url.startsWith('/titles/') ? id : undefined,
      jobId: url.startsWith('/jobs/') ? id : undefined,
      context: {
        method: request.method,
        url,
        status,
        ms: Math.round(reply.elapsedTime),
        ip: request.ip,
        ...(request.isMultipart() ? { multipart: true } : {}),
        ...(request.body !== undefined && request.body !== null ? { body: summarize(request.body) } : {})
      }
    })
  })

  // @fastify/cors v11 only preflights GET/HEAD/POST by default; the UI also uses PUT and DELETE
  await app.register(cors, { origin: opts.allowedOrigins, methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'] })
  // Movies are large: no per-file size limit, one file per request
  await app.register(multipart, { limits: { fileSize: Number.MAX_SAFE_INTEGER, files: 1 } })
  await app.register(websocket)

  // Non-loopback callers exist only while LAN access is enabled, and must present the token
  app.addHook('onRequest', async (request, reply) => {
    const header = (name: string): string | undefined => {
      const value = request.headers[name]
      return Array.isArray(value) ? value[0] : value
    }
    const decision = checkAccess(
      {
        ip: request.ip,
        method: request.method,
        authorization: header('authorization'),
        apiKey: header('x-api-key'),
        upgrade: header('upgrade'),
        queryToken: stringParam((request.query as Record<string, unknown> | undefined)?.token)
      },
      opts.context.repos.settings.getConfig()
    )
    if (!decision.ok) {
      request.failure = decision.message
      return reply
        .code(decision.statusCode)
        .send({ statusCode: decision.statusCode, error: STATUS_TEXT[decision.statusCode], message: decision.message })
    }
  })

  await app.register(healthRoutes, { version: opts.version })
  await app.register(configRoutes, { repos: opts.context.repos, events: opts.context.events, log })
  await app.register(titlesRoutes, { context: opts.context })
  await app.register(jobsRoutes, { context: opts.context, allowedOrigins: opts.allowedOrigins })
  await app.register(systemRoutes, { context: opts.context })
  await app.register(logsRoutes, { context: opts.context })

  return app
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = await createServer(opts)
  await app.listen({ host: opts.host, port: opts.port })
  return app
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// The WebSocket token travels in the query string: never into the log
function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, '$1…')
}

const MAX_STRING = 300
const MAX_ITEMS = 20

// Request bodies as logged: long strings and lists are cut, nothing else changes
function summarize(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(summarize).concat(value.length > MAX_ITEMS ? [`… ${value.length - MAX_ITEMS} más`] : [])
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarize(item)]))
  return value
}
