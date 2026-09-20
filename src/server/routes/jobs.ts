import type { FastifyPluginAsync } from 'fastify'
import type { JobStatus } from '@shared/model'
import type { ServerContext } from '../context'
import { HttpError, badRequest, notFound } from '../errors'

const JOB_STATUSES: JobStatus[] = ['queued', 'running', 'done', 'error', 'cancelled']
const ACTIVE_STATUSES: JobStatus[] = ['queued', 'running']

export const jobsRoutes: FastifyPluginAsync<{ context: ServerContext; allowedOrigins: string[] }> = async (
  app,
  { context, allowedOrigins }
) => {
  const { repos, runner, events } = context

  // ?status=queued,running (default: active jobs); ?status=all for everything
  app.get<{ Querystring: { status?: string } }>('/jobs', async (request) => {
    const raw = request.query.status
    if (!raw) return repos.jobs.list({ status: ACTIVE_STATUSES })
    if (raw === 'all') return repos.jobs.list()

    const statuses = raw.split(',').map((s) => s.trim())
    const invalid = statuses.filter((s) => !JOB_STATUSES.includes(s as JobStatus))
    if (invalid.length > 0) throw badRequest(`Estado desconocido: ${invalid.join(', ')}`)
    return repos.jobs.list({ status: statuses as JobStatus[] })
  })

  app.get<{ Params: { id: string } }>('/jobs/:id', async (request) => {
    const job = repos.jobs.get(request.params.id)
    if (!job) throw notFound('Job no encontrado')
    return job
  })

  // Everything ffmpeg and the packager printed while the job ran, as plain text
  app.get<{ Params: { id: string } }>('/jobs/:id/log', async (request, reply) => {
    const job = repos.jobs.get(request.params.id)
    if (!job) throw notFound('Job no encontrado')
    const text = context.jobOutput?.read(job.id) ?? null
    if (text === null) throw notFound('Este job no tiene salida registrada')
    return reply.type('text/plain; charset=utf-8').send(text)
  })

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (request, reply) => {
    const job = repos.jobs.get(request.params.id)
    if (!job) throw notFound('Job no encontrado')
    if (!(await runner.cancel(job.id))) throw new HttpError(409, `El job ya terminó (${job.status})`)
    return reply.code(202).send(repos.jobs.get(job.id))
  })

  // Live feed: a snapshot of active jobs on connect, then every server event as JSON
  app.get('/jobs/stream', { websocket: true }, (socket, request) => {
    // Browsers skip CORS for WebSockets, so the renderer allowlist is enforced by hand
    const origin = request.headers.origin
    if (origin && !allowedOrigins.includes(origin)) {
      socket.close(1008, 'origen no permitido')
      return
    }

    socket.send(JSON.stringify({ type: 'snapshot', jobs: repos.jobs.list({ status: ACTIVE_STATUSES }) }))
    const unsubscribe = events.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
    })
    socket.on('close', unsubscribe)
    socket.on('error', unsubscribe)
  })
}
