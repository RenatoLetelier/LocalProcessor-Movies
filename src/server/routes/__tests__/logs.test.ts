import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/model'
import type { LogEntry } from '@shared/model'
import { createTestServer, fakePipeline, type TestServer } from './helpers'

let root: string
let server: TestServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lp-logs-api-'))
  server = await createTestServer({ outputFolder: root })
})

afterEach(async () => {
  await server.app.close()
  rmSync(root, { recursive: true, force: true })
})

const source = (name: string): string => {
  const path = join(root, `${name}.mkv`)
  writeFileSync(path, 'x')
  return path
}

async function logs(query = ''): Promise<LogEntry[]> {
  const res = await server.app.inject({ method: 'GET', url: `/logs${query}` })
  expect(res.statusCode).toBe(200)
  return res.json()
}

function untilJob(jobId: string, status: Job['status']): Promise<Job> {
  return new Promise((resolve) => {
    const current = server.db.repos.jobs.get(jobId)
    if (current?.status === status) return resolve(current)
    const unsubscribe = server.events.subscribe((e) => {
      if (e.type === 'job.updated' && e.job.id === jobId && e.job.status === status) {
        unsubscribe()
        resolve(e.job)
      }
    })
  })
}

describe('request logging', () => {
  it('records every state-changing request and every rejection, never plain GETs', async () => {
    await server.app.inject({ method: 'GET', url: '/titles' })
    const bad = await server.app.inject({ method: 'POST', url: '/titles', payload: { name: 'sin ruta' } })
    expect(bad.statusCode).toBe(400)
    const missing = await server.app.inject({ method: 'GET', url: '/titles/nope' })
    expect(missing.statusCode).toBe(404)
    await server.app.inject({ method: 'PUT', url: '/config', payload: { segmentDurationSeconds: 4 } })

    const api = (await logs('?category=api')).map((e) => [e.level, e.message])
    expect(api).toEqual([
      ['warn', 'POST /titles → 400: sourcePath es obligatorio'],
      ['warn', 'GET /titles/nope → 404: Título no encontrado'],
      ['info', 'PUT /config → 200']
    ])
    const entry = (await logs('?category=api&level=info&q=config'))[0]!
    expect(entry.context).toMatchObject({ method: 'PUT', url: '/config', status: 200, ip: '127.0.0.1', body: { segmentDurationSeconds: 4 } })
    expect(typeof entry.context?.ms).toBe('number')
  })

  it('ties the api entry to the title or job of the route', async () => {
    const created = await server.app.inject({ method: 'POST', url: '/titles', payload: { sourcePath: source('a') } })
    const { title, job } = created.json()
    await untilJob(job.id, 'done')
    await server.app.inject({ method: 'POST', url: `/jobs/${job.id}/cancel` })
    await server.app.inject({ method: 'DELETE', url: `/titles/${title.id}` })

    const byTitle = (await logs(`?category=api&titleId=${title.id}`)).map((e) => e.message)
    expect(byTitle).toEqual([`DELETE /titles/${title.id} → 204`])
    const byJob = (await logs(`?category=api&jobId=${job.id}`)).map((e) => e.message)
    expect(byJob).toEqual([`POST /jobs/${job.id}/cancel → 409: El job ya terminó (done)`])
  })
})

describe('title and job entries', () => {
  it('logs the creation, the queued job, every pipeline step and the completion', async () => {
    const created = await server.app.inject({ method: 'POST', url: '/titles', payload: { sourcePath: source('peli'), name: 'Peli' } })
    expect(created.statusCode).toBe(201)
    const { title, job } = created.json()
    await untilJob(job.id, 'done')

    const entries = await logs(`?titleId=${title.id}&level=info`)
    const messages = entries.filter((e) => e.category !== 'api').map((e) => `${e.category}: ${e.message}`)
    expect(messages[0]).toBe('titles: Título creado: «Peli»')
    expect(messages[1]).toBe('jobs: Job inicial encolado para «Peli»')
    expect(messages).toContain('jobs: Job inicial iniciado para «Peli» (intento 1 de 3)')
    expect(messages.some((m) => m.startsWith('jobs: Paso probe terminado en'))).toBe(true)
    expect(messages.some((m) => m.startsWith('jobs: Job inicial completado en'))).toBe(true)

    const created_ = entries.find((e) => e.message.startsWith('Título creado'))!
    expect(created_.context).toMatchObject({ sourcePath: join(root, 'peli.mkv'), width: 1920, height: 800, codec: 'h264', outputFolder: join(root, title.id) })
    const queued = entries.find((e) => e.message.startsWith('Job inicial encolado'))!
    expect(queued.job_id).toBe(job.id)
    expect(queued.context).toMatchObject({ tipo: 'inicial', qualities: ['2160p', '1080p', '720p', '480p'], standards: ['hls', 'dash'], outputFolder: root })
    expect(queued.context).not.toHaveProperty('rungs')
    const done = entries.find((e) => e.message.startsWith('Job inicial completado'))!
    expect(done.context).toMatchObject({ outputFolder: join(root, title.id), renditions: ['1080p', '720p', '480p'] })
    expect(done.context?.steps).toHaveProperty('encode')

    // Progress milestones stay at debug level
    const debug = await logs(`?jobId=${job.id}&level=debug&q=Progreso`)
    expect(debug.length).toBeGreaterThan(0)
    expect((await logs(`?jobId=${job.id}&level=info&q=Progreso`)).length).toBe(0)
  })

  it('logs a failure with the step, the error and the tail of the job output', async () => {
    await server.app.close()
    server = await createTestServer({ outputFolder: root, pipeline: fakePipeline({ fail: 'ffmpeg terminó con código 1' }) })
    const created = await server.app.inject({ method: 'POST', url: '/titles', payload: { sourcePath: source('mala') } })
    const { title, job } = created.json()
    await untilJob(job.id, 'error')

    const failure = (await logs(`?jobId=${job.id}&level=error`))[0]!
    expect(failure.message).toBe('Job inicial falló en encode: ffmpeg terminó con código 1')
    expect(failure.title_id).toBe(title.id)
    expect(failure.context).toMatchObject({ step: 'encode', error: 'ffmpeg terminó con código 1', errorType: 'Error', output: [] })
    expect(failure.context).toHaveProperty('stack')
  })

  it('serves the full job output as text and removes it with the title', async () => {
    const created = await server.app.inject({ method: 'POST', url: '/titles', payload: { sourcePath: source('salida') } })
    const { title, job } = created.json()
    await untilJob(job.id, 'done')

    const text = await server.app.inject({ method: 'GET', url: `/jobs/${job.id}/log` })
    expect(text.statusCode).toBe(200)
    expect(text.headers['content-type']).toMatch(/^text\/plain/)
    expect(text.body).toMatch(/\d{4}-\d{2}-\d{2}T\S+ fake pipeline done\n/)
    expect((await server.app.inject({ method: 'GET', url: '/jobs/nope/log' })).statusCode).toBe(404)

    await server.app.inject({ method: 'DELETE', url: `/titles/${title.id}` })
    expect((await server.app.inject({ method: 'GET', url: `/jobs/${job.id}/log` })).statusCode).toBe(404)
    const deleted = (await logs(`?titleId=${title.id}&category=titles&q=eliminado`))[0]!
    expect(deleted.context).toMatchObject({ outputFolder: join(root, title.id), uploadRemoved: false, jobsRemoved: 1, cancelledJobs: [] })
  })
})

describe('config entries', () => {
  it('logs each changed field with its previous and new value, never the token', async () => {
    await server.app.inject({ method: 'PUT', url: '/config', payload: { qualities: ['1080p', '720p'], segmentDurationSeconds: 6 } })
    await server.app.inject({ method: 'PUT', url: '/config', payload: { apiAccess: 'lan' } })
    await server.app.inject({ method: 'POST', url: '/config/api-token' })
    const token = server.db.repos.settings.getConfig().apiToken!

    const entries = await logs('?category=config')
    expect(entries.map((e) => e.message)).toEqual([
      'Configuración actualizada: qualities',
      'Configuración actualizada: apiAccess, apiToken (token de acceso generado)',
      'Token de acceso desde la red regenerado; el anterior deja de valer'
    ])
    expect(entries[0]!.context).toEqual({ changes: { qualities: { from: ['2160p', '1080p', '720p', '480p'], to: ['1080p', '720p'] } }, ip: '127.0.0.1' })
    expect(entries[1]!.context).toMatchObject({ changes: { apiAccess: { from: 'local', to: 'lan' }, apiToken: { from: null, to: '(token nuevo)' } } })
    expect(JSON.stringify(entries)).not.toContain(token)
  })
})

describe('GET /logs', () => {
  it('validates the query and exports text', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/logs?level=loud' })).statusCode).toBe(400)
    expect((await server.app.inject({ method: 'GET', url: '/logs?limit=0' })).statusCode).toBe(400)

    await server.app.inject({ method: 'PUT', url: '/config', payload: { segmentDurationSeconds: 8 } })
    const text = await server.app.inject({ method: 'GET', url: '/logs?format=text&category=config' })
    expect(text.headers['content-type']).toMatch(/^text\/plain/)
    expect(text.body).toMatch(/^\S+ INFO {2}config {3}Configuración actualizada: segmentDurationSeconds \| \{"changes":\{"segmentDurationSeconds":\{"from":6,"to":8\}\}.*\n$/)
  })
})
