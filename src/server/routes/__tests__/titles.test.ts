import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Response as InjectResponse } from 'light-my-request'
import type { Job } from '@shared/model'
import { createTestServer, fakePipeline, fakeSource, type TestServer } from './helpers'

let root: string
let server: TestServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lp-titles-'))
  writeFileSync(join(root, 'movie.mkv'), 'not really a movie')
  server = await createTestServer({ outputFolder: root, pipeline: fakePipeline({ ticks: 2 }) })
})

afterEach(async () => {
  await server.app.close()
  rmSync(root, { recursive: true, force: true })
})

const post = (payload: object): Promise<InjectResponse> => server.app.inject({ method: 'POST', url: '/titles', payload })

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

describe('POST /titles with HDR sources', () => {
  const hdrProbe = (dolbyVisionProfile: number | null) => async (_b: unknown, path: string) => {
    const info = fakeSource(path, { codec: 'hevc', pixelFormat: 'yuv420p10le' })
    info.video.hdr = { transfer: 'pq', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020', colorSpace: 'bt2020nc', peakNits: 1000, dolbyVisionProfile }
    return info
  }

  it('records the HDR transfer of the source on the title', async () => {
    await server.app.close()
    server = await createTestServer({ outputFolder: root, pipeline: fakePipeline({ ticks: 1 }), probe: hdrProbe(8) })
    const res = await post({ sourcePath: join(root, 'movie.mkv') })
    expect(res.statusCode).toBe(201)
    expect(res.json().title.source_hdr).toBe('pq')
  })

  it('refuses Dolby Vision profile 5 up front instead of producing a tinted picture', async () => {
    await server.app.close()
    server = await createTestServer({ outputFolder: root, pipeline: fakePipeline({ ticks: 1 }), probe: hdrProbe(5) })
    const res = await post({ sourcePath: join(root, 'movie.mkv') })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/Dolby Vision perfil 5/)
    expect(server.db.repos.titles.list()).toHaveLength(0)
  })
})

describe('POST /titles', () => {
  it('requires the output folder to be configured', async () => {
    const bare = await createTestServer()
    const res = await bare.app.inject({ method: 'POST', url: '/titles', payload: { sourcePath: join(root, 'movie.mkv') } })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/carpeta de salida/)
    await bare.app.close()
  })

  it('validates the source path', async () => {
    expect((await post({})).statusCode).toBe(400)
    expect((await post({ sourcePath: 'relative/movie.mkv' })).json().message).toMatch(/absoluta/)
    expect((await post({ sourcePath: join(root, 'missing.mkv') })).json().message).toMatch(/no existe/)
    expect((await post({ sourcePath: root })).json().message).toMatch(/no es un archivo/)
  })

  it('rejects invalid per-title overrides before touching anything', async () => {
    const res = await post({ sourcePath: join(root, 'movie.mkv'), qualities: ['4k'] })
    expect(res.statusCode).toBe(400)
    expect(res.json().problems).toEqual(['qualities: "4k" no está definida en rungs'])
    expect(server.db.repos.titles.list()).toEqual([])
  })

  it('creates the title with probe data and an initial job that runs to completion', async () => {
    const res = await post({ sourcePath: join(root, 'movie.mkv'), name: 'Mi película', standards: ['hls'] })
    expect(res.statusCode).toBe(201)
    const { title, job } = res.json()
    expect(title).toMatchObject({
      name: 'Mi película',
      status: 'queued',
      source_width: 1920,
      source_height: 800,
      source_video_bitrate: 4_000_000,
      source_fps: 24,
      source_video_codec: 'h264',
      duration_seconds: 60,
      source_managed: false,
      output_folder: join(root, title.id)
    })
    expect(title.source_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(job).toMatchObject({ title_id: title.id, tipo: 'inicial', status: 'queued', attempts: 0 })
    expect(JSON.parse(job.config_json)).toMatchObject({ outputFolder: root, standards: ['hls'], qualities: ['2160p', '1080p', '720p', '480p'] })

    await untilJob(job.id, 'done')
    const detail = await server.app.inject({ method: 'GET', url: `/titles/${title.id}` })
    expect(detail.json()).toMatchObject({
      status: 'done',
      renditions: [{ label: '1080p' }, { label: '720p' }, { label: '480p' }],
      audio_tracks: [{ language: 'es' }, { language: 'en' }],
      subtitle_tracks: [
        { status: 'pending', requiere_ocr: true },
        { status: 'done', formato_salida: 'vtt' }
      ],
      jobs: [{ id: job.id, status: 'done', progress: 100 }]
    })
    expect(existsSync(join(root, title.id, 'metadata.json'))).toBe(true)

    const files = await server.app.inject({ method: 'GET', url: `/titles/${title.id}/files` })
    expect(files.json()).toMatchObject({
      root: join(root, title.id),
      exists: true,
      fileCount: 2,
      entries: [
        { name: 'master.m3u8', kind: 'file', fileCount: 1 },
        { name: 'metadata.json', kind: 'file', fileCount: 1 }
      ]
    })
  })

  it('reports a missing output folder instead of failing', async () => {
    const { title } = (await post({ sourcePath: join(root, 'movie.mkv') })).json()
    const files = await server.app.inject({ method: 'GET', url: `/titles/${title.id}/files` })
    expect(files.json()).toMatchObject({ exists: false, entries: [] })
  })

  it('refuses to register the same source twice', async () => {
    const first = await post({ sourcePath: join(root, 'movie.mkv') })
    const second = await post({ sourcePath: join(root, 'movie.mkv') })
    expect(second.statusCode).toBe(409)
    expect(second.json().titleId).toBe(first.json().title.id)
  })

  it('stores multipart uploads under .uploads and owns them', async () => {
    const boundary = 'lp-test-boundary'
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="name"',
      '',
      'Subida',
      `--${boundary}`,
      'Content-Disposition: form-data; name="qualities"',
      '',
      '720p,480p',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="Up Loaded.MKV"',
      'Content-Type: video/x-matroska',
      '',
      'fake bytes',
      `--${boundary}--`,
      ''
    ].join('\r\n')

    const res = await server.app.inject({
      method: 'POST',
      url: '/titles',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })
    expect(res.statusCode).toBe(201)
    const { title, job } = res.json()
    expect(title.name).toBe('Subida')
    expect(title.source_managed).toBe(true)
    expect(title.source_path).toBe(join(root, '.uploads', `${title.id}.mkv`))
    expect(existsSync(title.source_path)).toBe(true)
    expect(JSON.parse(job.config_json).qualities).toEqual(['720p', '480p'])

    await untilJob(job.id, 'done')
    const del = await server.app.inject({ method: 'DELETE', url: `/titles/${title.id}` })
    expect(del.statusCode).toBe(204)
    expect(existsSync(title.source_path)).toBe(false)
    expect(existsSync(join(root, title.id))).toBe(false)
    expect(server.db.repos.titles.get(title.id)).toBeUndefined()
  })
})

describe('DELETE /titles/:id', () => {
  it('cancels the running job, removes the folder and keeps user-provided sources', async () => {
    await server.app.close()
    server = await createTestServer({ outputFolder: root, pipeline: fakePipeline({ ticks: 200, tickMs: 20 }) })
    const { title, job } = (await post({ sourcePath: join(root, 'movie.mkv') })).json()
    await untilJob(job.id, 'running')

    const del = await server.app.inject({ method: 'DELETE', url: `/titles/${title.id}` })
    expect(del.statusCode).toBe(204)
    expect(server.runner.hasRunning()).toBe(false)
    expect(existsSync(join(root, 'movie.mkv'))).toBe(true)
    expect(readdirSync(root).filter((f) => f !== 'movie.mkv')).toEqual([])
    expect((await server.app.inject({ method: 'GET', url: `/titles/${title.id}` })).statusCode).toBe(404)
  })

  it('returns 404 for unknown titles', async () => {
    expect((await server.app.inject({ method: 'DELETE', url: '/titles/nope' })).statusCode).toBe(404)
  })
})
