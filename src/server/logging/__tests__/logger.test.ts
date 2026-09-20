import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerEvent } from '@shared/api'
import { openDatabase, type AppDatabase } from '../../db'
import { ServerEvents } from '../../jobs/events'
import { FileSink } from '../file-sink'
import { formatEntry } from '../format'
import { JobOutputStore } from '../job-output'
import { AppLogger, errorContext } from '../logger'

let root: string
let db: AppDatabase

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-logs-'))
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('AppLogger', () => {
  it('writes the text file at once and the table once a store is attached, in order', () => {
    const file = join(root, 'app.log')
    const log = new AppLogger({ file: new FileSink(file) })
    log.info('app', 'Arrancando', { context: { version: '1.2.0' } })
    log.warn('app', 'Sin base todavía')

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ INFO {2}app {6}Arrancando \| \{"version":"1.2.0"\}$/)
    expect(db.repos.logs.count()).toBe(0)

    const events = new ServerEvents()
    const seen: ServerEvent[] = []
    events.subscribe((e) => seen.push(e))
    log.attachStore(db.repos.logs, events)
    log.error('jobs', 'Falló', { jobId: 'j1', titleId: 't1', context: { step: 'encode' } })

    const stored = db.repos.logs.list()
    expect(stored.map((e) => [e.level, e.category, e.message])).toEqual([
      ['info', 'app', 'Arrancando'],
      ['warn', 'app', 'Sin base todavía'],
      ['error', 'jobs', 'Falló']
    ])
    expect(stored[2]).toMatchObject({ job_id: 'j1', title_id: 't1', context: { step: 'encode' } })
    expect(stored[0]!.id).toBeLessThan(stored[2]!.id)
    // Every stored entry is broadcast, the buffered ones included
    expect(seen).toEqual(stored.map((entry) => ({ type: 'log.entry', entry })))
  })

  it('keeps nothing when silent and survives contexts that cannot be serialized', () => {
    const silent = AppLogger.silent()
    silent.attachStore(db.repos.logs)
    silent.info('app', 'nada')
    expect(db.repos.logs.count()).toBe(0)

    const log = new AppLogger()
    log.attachStore(db.repos.logs)
    log.info('app', 'raro', { context: { big: BigInt(1) } as unknown as Record<string, unknown> })
    expect(db.repos.logs.list()[0]!.context).toEqual({ error: 'contexto no serializable' })
  })

  it('prunes the oldest rows past maxEntries', () => {
    const log = new AppLogger({ retention: { maxEntries: 20 } })
    log.attachStore(db.repos.logs)
    for (let i = 1; i <= 600; i++) log.info('app', `entrada ${i}`)
    expect(db.repos.logs.count()).toBeLessThanOrEqual(120)
    const kept = db.repos.logs.list({ limit: 1000 })
    expect(kept[kept.length - 1]!.message).toBe('entrada 600')
    expect(kept[0]!.message).not.toBe('entrada 1')
    log.close()
  })

  it('keeps seven days and the last 100 jobs by default', () => {
    const log = new AppLogger()
    expect(log.retention).toEqual({ maxAgeDays: 7, maxJobs: 100, maxEntries: 50_000 })
    log.attachStore(db.repos.logs)
    for (let job = 1; job <= 103; job++) {
      log.info('jobs', `Job ${job} iniciado`, { jobId: `job-${job}` })
      log.info('jobs', `Job ${job} completado`, { jobId: `job-${job}` })
    }
    log.info('config', 'Configuración actualizada')
    // Older than a week: gone whatever the job
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString()
    db.repos.logs.insert({ ts: eightDaysAgo, level: 'info', category: 'app', message: 'antigua' })
    db.repos.logs.insert({ ts: eightDaysAgo, level: 'info', category: 'jobs', message: 'job antiguo', jobId: 'job-103' })

    expect(log.prune()).toBe(3 * 2 + 2)
    const kept = db.repos.logs.list({ limit: 1000 })
    expect(kept.some((e) => e.job_id === 'job-3')).toBe(false)
    expect(kept.some((e) => e.job_id === 'job-4')).toBe(true)
    expect(kept.filter((e) => e.job_id === 'job-103')).toHaveLength(2)
    expect(kept.some((e) => e.message === 'antigua')).toBe(false)
    expect(kept.some((e) => e.message === 'Configuración actualizada')).toBe(true)
    log.close()
  })

  it('describes errors with their own fields', () => {
    class Custom extends Error {
      code = 12
    }
    expect(errorContext(new Custom('boom'))).toMatchObject({ error: 'boom', errorType: 'Error', code: 12 })
    expect(errorContext('texto')).toEqual({ error: 'texto' })
  })
})

describe('LogsRepository.list', () => {
  beforeEach(() => {
    const log = new AppLogger()
    log.attachStore(db.repos.logs)
    log.debug('jobs', 'Progreso 10 %', { jobId: 'j1', titleId: 't1' })
    log.info('titles', 'Título creado: «Peli»', { titleId: 't1', context: { sourcePath: 'C:/peli.mkv' } })
    log.warn('api', 'POST /titles → 400: sourcePath es obligatorio')
    log.error('jobs', 'Job falló en encode', { jobId: 'j1', titleId: 't1' })
    log.info('config', 'Configuración actualizada: qualities')
  })

  it('filters by minimum level, category, job, title and text', () => {
    const messages = (entries: ReturnType<typeof db.repos.logs.list>): string[] => entries.map((e) => e.message)
    expect(messages(db.repos.logs.list({ level: 'warn' }))).toEqual(['POST /titles → 400: sourcePath es obligatorio', 'Job falló en encode'])
    expect(messages(db.repos.logs.list({ level: 'info' }))).toHaveLength(4)
    expect(messages(db.repos.logs.list({ category: 'jobs' }))).toEqual(['Progreso 10 %', 'Job falló en encode'])
    expect(messages(db.repos.logs.list({ jobId: 'j1', level: 'error' }))).toEqual(['Job falló en encode'])
    expect(messages(db.repos.logs.list({ titleId: 't1' }))).toHaveLength(3)
    expect(messages(db.repos.logs.list({ q: 'peli.mkv' }))).toEqual(['Título creado: «Peli»'])
    expect(messages(db.repos.logs.list({ q: '100%' }))).toEqual([])
  })

  it('pages towards the past with before and limit', () => {
    const last = db.repos.logs.list({ limit: 2 })
    expect(last.map((e) => e.message)).toEqual(['Job falló en encode', 'Configuración actualizada: qualities'])
    const older = db.repos.logs.list({ limit: 2, before: last[0]!.id })
    expect(older.map((e) => e.message)).toEqual(['Título creado: «Peli»', 'POST /titles → 400: sourcePath es obligatorio'])
  })
})

describe('FileSink', () => {
  it('rotates at the size limit and keeps the configured copies', () => {
    const file = join(root, 'app.log')
    const sink = new FileSink(file, { maxBytes: 100, keep: 2 })
    for (let i = 0; i < 12; i++) sink.write(`línea ${i} ${'x'.repeat(30)}`)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(root, 'app.1.log'))).toBe(true)
    expect(existsSync(join(root, 'app.2.log'))).toBe(true)
    expect(existsSync(join(root, 'app.3.log'))).toBe(false)
    expect(readFileSync(file, 'utf8')).toContain('línea 11')
  })
})

describe('JobOutputStore', () => {
  it('writes timestamped lines per job, keeps a tail and reads the file back', () => {
    const store = new JobOutputStore(join(root, 'jobs'))
    const writer = store.open('job-1')
    for (let i = 1; i <= 250; i++) writer.write(`frame=${i}`)
    writer.close()
    writer.write('después de cerrar')

    expect(writer.tail()).toHaveLength(200)
    expect(writer.tail()[0]).toBe('frame=51')
    const text = store.read('job-1')!
    expect(text.split('\n').filter(Boolean)).toHaveLength(250)
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ frame=1\n/)
    expect(store.read('missing')).toBeNull()

    store.remove(['job-1'])
    expect(store.read('job-1')).toBeNull()

    // Nothing written: no file to serve
    const empty = store.open('job-2')
    empty.close()
    expect(existsSync(store.path('job-2'))).toBe(false)
    expect(store.read('job-2')).toBeNull()
  })

  it('prunes all but the most recent files, and anything older than the age limit', () => {
    const store = new JobOutputStore(join(root, 'jobs'))
    const now = new Date(2026, 0, 10).getTime()
    for (let i = 0; i < 5; i++) {
      writeFileSync(store.path(`job-${i}`), 'x')
      // Distinct modification times so the order is unambiguous: job-0 is 9 days old, job-4 five
      const stamp = new Date(2026, 0, 1 + i)
      utimesSync(store.path(`job-${i}`), stamp, stamp)
    }
    expect(store.prune(2, 7, now)).toBe(3)
    expect(store.read('job-4')).toBe('x')
    expect(store.read('job-3')).toBe('x')
    expect(store.read('job-2')).toBeNull()

    // Within the count limit but past the age limit (job-3 is six days old, job-4 five)
    expect(store.prune(2, 5.5, now)).toBe(1)
    expect(store.read('job-4')).toBe('x')
    expect(store.read('job-3')).toBeNull()
  })
})

describe('formatEntry', () => {
  it('prefixes the job or title and appends the context', () => {
    const line = formatEntry({ ts: '2026-09-20T10:00:00.000Z', level: 'warn', category: 'jobs', message: 'Job falló', job_id: '6a1d9b3c-2e4f', title_id: null, context: { step: 'encode' } })
    expect(line).toBe('2026-09-20T10:00:00.000Z WARN  jobs     [job 6a1d9b3c] Job falló | {"step":"encode"}')
  })
})
