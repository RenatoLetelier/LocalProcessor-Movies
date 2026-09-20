import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/model'
import { openDatabase, type AppDatabase } from '../../db'
import { ServerEvents, type ServerEvent } from '../events'
import { JobRunner, MAX_ATTEMPTS, type PipelineFn } from '../runner'
import { enqueueTitle } from '../enqueue'
import { FAKE_BINARIES, fakePipeline, fakeProbe } from '../../routes/__tests__/helpers'

let root: string
let db: AppDatabase
let events: ServerEvents
let received: ServerEvent[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-runner-'))
  db = openDatabase(':memory:')
  db.repos.settings.updateConfig({ outputFolder: root })
  events = new ServerEvents()
  received = []
  events.subscribe((e) => received.push(e))
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const makeRunner = (pipeline: PipelineFn, concurrency = 1): JobRunner =>
  new JobRunner({ db: db.db, repos: db.repos, events, binaries: FAKE_BINARIES, pipeline, concurrency })

async function enqueue(name: string): Promise<{ titleId: string; jobId: string }> {
  const { title, job } = await enqueueTitle(
    { repos: db.repos, events, binaries: FAKE_BINARIES, probe: fakeProbe, checkDiskSpace: false },
    { sourcePath: join(root, `${name}.mkv`), name }
  )
  return { titleId: title.id, jobId: job.id }
}

// enqueueTitle stats the source, so the fake sources must exist on disk
async function touch(name: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, `${name}.mkv`), 'x')
}

function untilJob(jobId: string, status: Job['status']): Promise<Job> {
  return new Promise((resolve) => {
    const check = (job: Job): boolean => job.id === jobId && job.status === status
    const current = db.repos.jobs.get(jobId)
    if (current && check(current)) return resolve(current)
    const unsubscribe = events.subscribe((e) => {
      if (e.type === 'job.updated' && check(e.job)) {
        unsubscribe()
        resolve(e.job)
      }
    })
  })
}

describe('JobRunner', () => {
  it('runs queued jobs one at a time in FIFO order and records the result', async () => {
    await touch('a')
    await touch('b')
    const a = await enqueue('a')
    const b = await enqueue('b')
    const runner = makeRunner(fakePipeline({ ticks: 2 }))
    runner.start()

    const doneA = await untilJob(a.jobId, 'done')
    // b must still be waiting while a runs (concurrency 1)
    expect(['queued', 'running']).toContain(db.repos.jobs.get(b.jobId)?.status)
    await untilJob(b.jobId, 'done')

    expect(doneA.progress).toBe(100)
    expect(doneA.attempts).toBe(1)
    expect(doneA.started_at).not.toBeNull()
    expect(doneA.finished_at).not.toBeNull()

    const title = db.repos.titles.get(a.titleId)!
    expect(title.status).toBe('done')
    expect(db.repos.renditions.listByTitle(a.titleId).map((r) => [r.label, r.status])).toEqual([
      ['1080p', 'done'],
      ['720p', 'done'],
      ['480p', 'done']
    ])
    expect(db.repos.audioTracks.listByTitle(a.titleId)).toMatchObject([
      { source_index: 1, language: 'es', codec_origen: 'aac', codec_salida: 'aac', channels: 2, status: 'done' },
      { source_index: 2, language: 'en', codec_origen: 'dts', codec_salida: 'aac', channels: 6, title: 'Comentarios', status: 'done' }
    ])
    expect(db.repos.subtitleTracks.listByTitle(a.titleId)).toMatchObject([
      { source_index: 3, formato_origen: 'hdmv_pgs_subtitle', formato_salida: null, requiere_ocr: true, status: 'pending' },
      { source_index: 4, language: 'en', formato_origen: 'subrip', formato_salida: 'vtt', requiere_ocr: false, status: 'done' }
    ])

    const progress = received.filter((e) => e.type === 'job.progress' && e.job.id === a.jobId)
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(received.some((e) => e.type === 'job.log')).toBe(true)
    await runner.stop()
  })

  it('ignores notify() until start() has run the recovery, so a job never runs twice', async () => {
    await touch('early')
    const early = await enqueue('early')
    const runner = makeRunner(fakePipeline({ ticks: 2 }))

    runner.notify()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(db.repos.jobs.get(early.jobId)?.status).toBe('queued')

    runner.start()
    const done = await untilJob(early.jobId, 'done')
    expect(done.attempts).toBe(1)
    await runner.stop()
  })

  it('marks job and title as error when the pipeline fails', async () => {
    await touch('bad')
    const { jobId, titleId } = await enqueue('bad')
    const runner = makeRunner(fakePipeline({ fail: 'ffmpeg terminó con código 1' }))
    runner.start()

    const job = await untilJob(jobId, 'error')
    expect(job.error).toBe('ffmpeg terminó con código 1')
    expect(db.repos.titles.get(titleId)).toMatchObject({ status: 'error', error: 'ffmpeg terminó con código 1' })
    await runner.stop()
  })

  it('cancels running and queued jobs, and refuses finished ones', async () => {
    await touch('slow')
    await touch('waiting')
    const slow = await enqueue('slow')
    const waiting = await enqueue('waiting')
    const runner = makeRunner(fakePipeline({ ticks: 200, tickMs: 20 }))
    runner.start()
    await untilJob(slow.jobId, 'running')

    expect(await runner.cancel(waiting.jobId)).toBe(true)
    expect(db.repos.jobs.get(waiting.jobId)?.status).toBe('cancelled')
    expect(db.repos.titles.get(waiting.titleId)?.status).toBe('error')

    expect(await runner.cancel(slow.jobId)).toBe(true)
    expect(db.repos.jobs.get(slow.jobId)).toMatchObject({ status: 'cancelled', error: 'Cancelado por el usuario' })
    expect(runner.hasRunning()).toBe(false)

    expect(await runner.cancel(slow.jobId)).toBe(false)
    expect(await runner.cancel('nope')).toBe(false)
  })

  it('re-queues jobs found running at startup and gives up after MAX_ATTEMPTS', async () => {
    await touch('crashed')
    await touch('hopeless')
    const crashed = await enqueue('crashed')
    const hopeless = await enqueue('hopeless')
    db.repos.jobs.update(crashed.jobId, { status: 'running', attempts: 1, progress: 40 })
    db.repos.jobs.update(hopeless.jobId, { status: 'running', attempts: MAX_ATTEMPTS })

    const runner = makeRunner(fakePipeline({ ticks: 1 }))
    runner.start()

    expect(db.repos.jobs.get(hopeless.jobId)).toMatchObject({ status: 'error', error: expect.stringContaining('Interrumpido') })
    const done = await untilJob(crashed.jobId, 'done')
    expect(done.attempts).toBe(2)
    await runner.stop()
  })

  it('stop() aborts the running job and leaves it queued for the next start', async () => {
    await touch('resume')
    const { jobId, titleId } = await enqueue('resume')
    const runner = makeRunner(fakePipeline({ ticks: 200, tickMs: 20 }))
    runner.start()
    await untilJob(jobId, 'running')

    await runner.stop()
    expect(db.repos.jobs.get(jobId)).toMatchObject({ status: 'queued', progress: 0, attempts: 0, started_at: null })
    expect(db.repos.titles.get(titleId)?.status).toBe('queued')

    const again = makeRunner(fakePipeline({ ticks: 1 }))
    again.start()
    expect((await untilJob(jobId, 'done')).attempts).toBe(1)
    await again.stop()
  })
})
