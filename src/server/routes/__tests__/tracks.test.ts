import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Response as InjectResponse } from 'light-my-request'
import type { Job } from '@shared/model'
import type { TitleMetadata } from '@pipeline/types'
import { createTestServer, fakePipeline, type TestServer } from './helpers'

let root: string
let server: TestServer

const start = async (options: Parameters<typeof createTestServer>[0] = {}): Promise<void> => {
  server = await createTestServer({ outputFolder: root, pipeline: fakePipeline({ ticks: 1 }), ...options })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-tracks-'))
  writeFileSync(join(root, 'movie.mkv'), 'not really a movie')
})

afterEach(async () => {
  await server.app.close()
  rmSync(root, { recursive: true, force: true })
})

const post = (payload: object): Promise<InjectResponse> => server.app.inject({ method: 'POST', url: '/titles', payload })
const putTracks = (titleId: string, payload: object): Promise<InjectResponse> => server.app.inject({ method: 'PUT', url: `/titles/${titleId}/tracks`, payload })
const published = (titleId: string): { metadata: TitleMetadata; master: string } => ({
  metadata: JSON.parse(readFileSync(join(root, titleId, 'metadata.json'), 'utf8')),
  master: readFileSync(join(root, titleId, 'master.m3u8'), 'utf8')
})

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

// The fake source: AAC stereo Spanish (1), DTS 5.1 English "Comentarios" (2), PGS (3), SRT forced English (4)
async function publishedTitle(tracks?: object): Promise<string> {
  const res = await post({ sourcePath: join(root, 'movie.mkv'), standards: ['hls'], ...(tracks ? { tracks } : {}) })
  expect(res.statusCode).toBe(201)
  await untilJob(res.json().job.id, 'done')
  return res.json().title.id
}

describe('copying the source video', () => {
  it('publishes the source as "original" plus the smallest quality, frozen in the job config', async () => {
    await start({ copyVideo: true })
    const res = await post({ sourcePath: join(root, 'movie.mkv'), standards: ['hls'] })
    expect(JSON.parse(res.json().job.config_json)).toMatchObject({ copyVideo: true, copyVideoMaxKbps: 12000 })
    await untilJob(res.json().job.id, 'done')
    const detail = (await server.app.inject({ method: 'GET', url: `/titles/${res.json().title.id}` })).json()
    expect(detail.renditions.map((r: { label: string }) => r.label)).toEqual(['original', '480p'])
    expect(published(res.json().title.id).metadata.renditions.map((r) => [r.label, r.copied ?? false])).toEqual([
      ['original', true],
      ['480p', false]
    ])
  })
})

describe('track overrides', () => {
  it('stores the overrides given with the title, normalised, and publishes with them', async () => {
    await start()
    const titleId = await publishedTitle({
      audio: [{ sourceIndex: 2, name: ' Inglés  "original" ', default: true }],
      subtitles: [{ sourceIndex: 4, language: 'spa', forced: false }]
    })
    expect(server.db.repos.titles.get(titleId)!.track_overrides).toEqual({
      audio: [{ sourceIndex: 2, name: 'Inglés original', default: true }],
      subtitles: [{ sourceIndex: 4, language: 'es', forced: false }]
    })
    const { metadata, master } = published(titleId)
    expect(metadata.audioTracks.map((t) => [t.sourceIndex, t.name, t.default])).toEqual([
      [1, 'Español', false],
      [2, 'Inglés original', true]
    ])
    expect(metadata.subtitleTracks[0]).toMatchObject({ sourceIndex: 4, language: 'es', forced: false, original: { language: 'en', forced: true } })
    expect(master).toContain('NAME="Inglés original",DEFAULT=YES')
    expect(master).toContain('NAME="Español",DEFAULT=NO')
  })

  it('rejects malformed tracks, or tracks the source does not have, before creating anything', async () => {
    await start()
    const unknown = await post({ sourcePath: join(root, 'movie.mkv'), tracks: { audio: [{ sourceIndex: 9 }] } })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().problems).toEqual(['tracks.audio[0].sourceIndex: el título no tiene la pista 9'])

    const malformed = await post({
      sourcePath: join(root, 'movie.mkv'),
      tracks: { audio: [{ sourceIndex: 1, forced: true, language: 'es_ES!' }, { sourceIndex: 2, default: true }, { sourceIndex: 1, default: true }], video: [] }
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().problems).toEqual([
      'tracks.video: campo desconocido',
      'tracks.audio[0].language: no es una etiqueta de idioma BCP-47 (es_ES!)',
      'tracks.audio[0].forced: solo existe para subtítulos',
      'tracks.audio[2].sourceIndex: la pista 1 está repetida',
      'tracks.audio: solo una pista puede ser la predeterminada'
    ])
    expect(server.db.repos.titles.list()).toEqual([])
  })

  it('relabels a published title in place, and goes back to the source with {}', async () => {
    await start()
    const titleId = await publishedTitle()

    const res = await putTracks(titleId, { audio: [{ sourceIndex: 1, name: 'Castellano' }, { sourceIndex: 2, language: 'en-GB', default: true }] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ applied: true, title: { id: titleId, track_overrides: { audio: [{ sourceIndex: 1, name: 'Castellano' }, { sourceIndex: 2, language: 'en-gb', default: true }] } } })
    const after = published(titleId)
    expect(after.master).toContain('LANGUAGE="es",NAME="Castellano",DEFAULT=NO')
    expect(after.master).toContain('LANGUAGE="en-gb",NAME="Comentarios",DEFAULT=YES')
    expect(res.json().metadata).toEqual(after.metadata)

    const back = await putTracks(titleId, {})
    expect(back.json()).toMatchObject({ applied: true, title: { track_overrides: null } })
    const source = published(titleId)
    expect(source.master).toContain('LANGUAGE="es",NAME="Español",DEFAULT=YES')
    expect(JSON.stringify(source.metadata)).not.toContain('original')
  })

  it('checks indexes against the published tracks and 404s unknown titles', async () => {
    await start()
    const titleId = await publishedTitle()
    const res = await putTracks(titleId, { subtitles: [{ sourceIndex: 1, name: 'x' }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().problems).toEqual(['tracks.subtitles[0].sourceIndex: el título no tiene la pista 1'])
    expect((await putTracks('nope', {})).statusCode).toBe(404)
  })

  it('keeps overrides sent while the first job runs and applies them when it publishes', async () => {
    await start({ pipeline: fakePipeline({ ticks: 20, tickMs: 15 }) })
    const res = await post({ sourcePath: join(root, 'movie.mkv'), standards: ['hls'] })
    await untilJob(res.json().job.id, 'running')

    const early = await putTracks(res.json().title.id, { audio: [{ sourceIndex: 2, name: 'Director', default: true }] })
    expect(early.json()).toMatchObject({ applied: false, metadata: null })

    await untilJob(res.json().job.id, 'done')
    expect(published(res.json().title.id).master).toContain('NAME="Director",DEFAULT=YES')
  })
})
