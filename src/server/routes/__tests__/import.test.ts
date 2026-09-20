import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImportSummary } from '@shared/api'
import type { ServerEvent } from '@shared/api'
import { indexFromTrackId } from '../../jobs/import'
import { createTestServer, fakeSource, type TestServer } from './helpers'

let root: string
let server: TestServer

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

// A published title folder as the pipeline leaves it, with a metadata.json of the given shape
function writeTitleFolder(base: string, id: string, metadata: Record<string, unknown>, opts: { manifests?: boolean } = {}): string {
  const dir = join(base, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata))
  if (opts.manifests !== false) {
    writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n')
    writeFileSync(join(dir, 'manifest.mpd'), '<MPD/>\n')
  }
  for (const r of (metadata.renditions as { path: string }[] | undefined) ?? []) {
    mkdirSync(join(dir, r.path), { recursive: true })
    writeFileSync(join(dir, r.path, 'playlist.m3u8'), '#EXTM3U\n')
  }
  return dir
}

const currentMetadata = (id: string, name: string, sourcePath: string) => ({
  schemaVersion: 1,
  titleId: id,
  name,
  durationSeconds: 5400,
  standards: ['hls', 'dash'],
  manifests: { hls: 'master.m3u8', dash: 'manifest.mpd' },
  segmentDurationSeconds: 6,
  dynamicRange: { source: 'pq', output: 'sdr' },
  source: { path: sourcePath, sizeBytes: 123, width: 3840, height: 2160, fps: 23.976, codec: 'hevc', bitrate: 40_000_000 },
  renditions: [
    { label: '2160p', width: 3840, height: 2160, bitrate: 13_000_000, maxBitrate: 16_000_000, codec: 'h264', path: 'video/2160p' },
    { label: '1080p', width: 1920, height: 1080, bitrate: 3_000_000, maxBitrate: 6_000_000, codec: 'h264', path: 'video/1080p' }
  ],
  audioTracks: [
    { id: '1_es_ac3', language: 'es', name: 'Español', codec: 'ac3', channels: 6, path: 'audio/1_es_ac3', sourceIndex: 1, sourceCodec: 'ac3' },
    { id: '1_es_aac', language: 'es', name: 'Español', codec: 'aac', channels: 6, path: 'audio/1_es_aac', sourceIndex: 1, sourceCodec: 'ac3' },
    { id: 'e1_fr_aac', language: 'fr', name: 'VF', codec: 'aac', channels: 2, path: 'audio/e1_fr_aac', sourceIndex: -1, sourceCodec: 'dts' }
  ],
  subtitleTracks: [{ id: '3_es', language: 'es', name: 'Español', format: 'vtt', forced: false, path: 'subs/3_es', sourceIndex: 3, sourceFormat: 'subrip' }],
  updatedAt: '2026-09-16T00:00:00.000Z'
})

// What the pipeline wrote before the source block and per-track source fields existed
const legacyMetadata = (id: string, name: string) => ({
  schemaVersion: 1,
  titleId: id,
  name,
  durationSeconds: 900,
  standards: ['hls'],
  manifests: { hls: 'master.m3u8' },
  segmentDurationSeconds: 6,
  renditions: [{ label: '720p', width: 1280, height: 534, bitrate: 2_000_000, maxBitrate: 3_000_000, codec: 'h264', path: 'video/720p' }],
  audioTracks: [{ id: '2_en_aac', language: 'en', name: 'English', codec: 'aac', channels: 2, path: 'audio/2_en_aac' }],
  subtitleTracks: [{ id: 'e2_de', language: 'de', name: 'Deutsch', format: 'vtt', forced: true, path: 'subs/e2_de' }],
  updatedAt: '2026-01-01T00:00:00.000Z'
})

const importTitles = async (): Promise<ImportSummary> => {
  const res = await server.app.inject({ method: 'POST', url: '/titles/import' })
  expect(res.statusCode).toBe(200)
  return res.json() as ImportSummary
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lp-import-'))
  server = await createTestServer({ outputFolder: root })
})

afterEach(async () => {
  await server.app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('POST /titles/import', () => {
  it('imports every valid title folder, current or legacy metadata, and reports the rest with a reason', async () => {
    const movie = join(root, 'movie.mkv')
    writeFileSync(movie, 'source bytes')
    writeTitleFolder(root, ID_A, currentMetadata(ID_A, 'Current', movie))
    writeTitleFolder(root, ID_B, legacyMetadata(ID_B, 'Legacy'))
    writeTitleFolder(root, ID_C, { ...legacyMetadata(ID_C, 'Broken'), renditions: [] })
    mkdirSync(join(root, '44444444-4444-4444-8444-444444444444'))
    mkdirSync(join(root, '.tmp', 'abc'), { recursive: true })
    mkdirSync(join(root, 'Otra carpeta'))
    const events: ServerEvent[] = []
    server.events.subscribe((e) => e.type !== 'log.entry' && events.push(e))

    const summary = await importTitles()
    expect(summary.imported.map((t) => t.name)).toEqual(['Current', 'Legacy'])
    expect(summary.relinked).toEqual([])
    expect(summary.skipped).toEqual([
      { folder: ID_C, reason: 'sin calidades publicadas' },
      { folder: '44444444-4444-4444-8444-444444444444', reason: 'sin metadata.json' },
      { folder: 'Otra carpeta', reason: 'el nombre no es un identificador de título' }
    ])
    expect(events.filter((e) => e.type === 'title.updated')).toHaveLength(2)

    const current = server.db.repos.titles.get(ID_A)!
    expect(current).toMatchObject({
      name: 'Current',
      status: 'done',
      source_path: movie,
      source_managed: false,
      source_width: 3840,
      source_height: 2160,
      source_video_codec: 'hevc',
      source_hdr: 'pq',
      duration_seconds: 5400,
      output_folder: join(root, ID_A)
    })
    expect(current.source_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(server.db.repos.renditions.listByTitle(ID_A).map((r) => [r.label, r.bitrate, r.status])).toEqual([
      ['2160p', 13_000_000, 'done'],
      ['1080p', 3_000_000, 'done']
    ])
    expect(server.db.repos.audioTracks.listByTitle(ID_A).map((a) => [a.source_index, a.language, a.codec_origen, a.codec_salida, a.channels]).sort()).toEqual([
      [-1, 'fr', 'dts', 'aac', 2],
      [1, 'es', 'ac3', 'aac', 6],
      [1, 'es', 'ac3', 'ac3', 6]
    ])
    expect(server.db.repos.subtitleTracks.listByTitle(ID_A).map((s) => [s.source_index, s.language, s.formato_origen, s.formato_salida])).toEqual([[3, 'es', 'subrip', 'vtt']])

    // Legacy files carry no source: the index comes from the track id and the codec is the published one
    const legacy = server.db.repos.titles.get(ID_B)!
    expect(legacy).toMatchObject({ name: 'Legacy', source_path: null, source_hash: null, source_hdr: null, source_width: null, duration_seconds: 900 })
    expect(server.db.repos.audioTracks.listByTitle(ID_B).map((a) => [a.source_index, a.codec_origen, a.codec_salida])).toEqual([[2, 'aac', 'aac']])
    expect(server.db.repos.subtitleTracks.listByTitle(ID_B).map((s) => [s.source_index, s.formato_origen])).toEqual([[-2, 'vtt']])

    // Running again changes nothing
    const again = await importTitles()
    expect(again.imported).toEqual([])
    expect(again.relinked).toEqual([])
    expect(server.db.repos.titles.list()).toHaveLength(2)
  })

  it('validates the folder contents before trusting metadata.json', async () => {
    writeTitleFolder(root, ID_A, { ...legacyMetadata(ID_A, 'A'), titleId: ID_B })
    writeTitleFolder(root, ID_B, legacyMetadata(ID_B, 'B'), { manifests: false })
    const noRendition = writeTitleFolder(root, ID_C, legacyMetadata(ID_C, 'C'))
    rmSync(join(noRendition, 'video'), { recursive: true })
    writeFileSync(join(writeTitleFolder(root, '55555555-5555-4555-8555-555555555555', {}), 'metadata.json'), '{ not json')

    const summary = await importTitles()
    expect(summary.imported).toEqual([])
    expect(summary.skipped).toEqual([
      { folder: ID_A, reason: `el titleId de metadata.json (${ID_B}) no coincide con la carpeta` },
      { folder: ID_B, reason: 'falta el manifiesto master.m3u8' },
      { folder: ID_C, reason: 'falta la carpeta video/720p' },
      { folder: '55555555-5555-4555-8555-555555555555', reason: 'metadata.json ilegible' }
    ])
  })

  it('re-points a known title whose recorded folder is gone, but never when that folder still exists', async () => {
    const moved = writeTitleFolder(root, ID_A, legacyMetadata(ID_A, 'Moved'))
    server.db.repos.titles.create({ id: ID_A, name: 'Moved', source_path: null, output_folder: join(root, 'old-place', ID_A), status: 'done' })
    const elsewhere = mkdtempSync(join(tmpdir(), 'lp-elsewhere-'))
    writeTitleFolder(elsewhere, ID_B, legacyMetadata(ID_B, 'Copied'))
    writeTitleFolder(root, ID_B, legacyMetadata(ID_B, 'Copied'))
    server.db.repos.titles.create({ id: ID_B, name: 'Copied', source_path: null, output_folder: join(elsewhere, ID_B), status: 'done' })

    try {
      const summary = await importTitles()
      expect(summary.relinked.map((t) => [t.id, t.output_folder])).toEqual([[ID_A, moved]])
      expect(summary.imported).toEqual([])
      expect(summary.skipped).toEqual([{ folder: ID_B, reason: `ya está en la biblioteca con otra carpeta: ${join(elsewhere, ID_B)}` }])
      expect(server.db.repos.titles.get(ID_A)?.output_folder).toBe(moved)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('needs an existing output folder', async () => {
    const bare = await createTestServer()
    expect((await bare.app.inject({ method: 'POST', url: '/titles/import' })).statusCode).toBe(409)
    await bare.app.close()
    server.db.repos.settings.updateConfig({ outputFolder: join(root, 'nope') })
    expect((await server.app.inject({ method: 'POST', url: '/titles/import' })).json().message).toMatch(/no existe/)
  })
})

describe('PUT /titles/:id/source', () => {
  const link = (id: string, sourcePath: string) => server.app.inject({ method: 'PUT', url: `/titles/${id}/source`, payload: { sourcePath } })

  beforeEach(async () => {
    writeTitleFolder(root, ID_A, { ...legacyMetadata(ID_A, 'Imported'), durationSeconds: 60 })
    await importTitles()
  })

  it('blocks reprocessing of an imported title until a source is linked', async () => {
    const res = await server.app.inject({ method: 'POST', url: `/titles/${ID_A}/reprocess`, payload: { tipo: 'agregar_calidad', qualities: ['480p'] } })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/importado sin archivo de origen/)
  })

  it('rejects files that are missing, relative, another title\'s, or of a different duration', async () => {
    expect((await link(ID_A, 'movie.mkv')).json().message).toMatch(/ruta absoluta/)
    expect((await link(ID_A, join(root, 'nope.mkv'))).json().message).toMatch(/no existe/)
    expect((await link('nope', join(root, 'nope.mkv'))).statusCode).toBe(404)

    writeFileSync(join(root, 'other.mkv'), 'x')
    const other = (await server.app.inject({ method: 'POST', url: '/titles', payload: { sourcePath: join(root, 'other.mkv') } })).json()
    const taken = await link(ID_A, join(root, 'other.mkv'))
    expect(taken.statusCode).toBe(409)
    expect(taken.json()).toMatchObject({ titleId: other.title.id })

    // The fake probe reports 60 s; a title of 90 minutes cannot be this file
    server.db.repos.titles.update(ID_A, { duration_seconds: 5400 })
    writeFileSync(join(root, 'long.mkv'), 'x')
    const mismatch = await link(ID_A, join(root, 'long.mkv'))
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.json().message).toBe('La duración no coincide: el archivo dura 0:01:00 y el título 1:30:00')
    expect(server.db.repos.titles.get(ID_A)?.source_path).toBeNull()
  })

  it('links the file, records what the probe found and makes reprocessing possible again', async () => {
    writeFileSync(join(root, 'movie.mkv'), 'source bytes')
    const events: ServerEvent[] = []
    server.events.subscribe((e) => e.type !== 'log.entry' && events.push(e))

    const res = await link(ID_A, join(root, 'movie.mkv'))
    expect(res.statusCode).toBe(200)
    const expected = fakeSource(join(root, 'movie.mkv'))
    expect(res.json()).toMatchObject({
      id: ID_A,
      source_path: join(root, 'movie.mkv'),
      source_managed: false,
      source_width: expected.video.displayWidth,
      source_height: expected.video.displayHeight,
      source_video_codec: 'h264',
      source_hdr: null,
      duration_seconds: 60
    })
    expect(res.json().source_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(events).toEqual([{ type: 'title.updated', title: res.json() }])

    const reprocess = await server.app.inject({ method: 'POST', url: `/titles/${ID_A}/reprocess`, payload: { tipo: 'agregar_calidad', qualities: ['480p'] } })
    expect(reprocess.statusCode).toBe(202)
  })
})

describe('indexFromTrackId', () => {
  it('reads the source index, negative for external tracks', () => {
    expect(indexFromTrackId('3_es_aac')).toBe(3)
    expect(indexFromTrackId('e1_fr_eac3')).toBe(-1)
    expect(indexFromTrackId('12_und')).toBe(12)
    expect(indexFromTrackId('audio')).toBeNull()
  })
})
