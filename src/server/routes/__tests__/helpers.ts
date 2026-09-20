import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import type { Binaries, IncrementalInput, PipelineHooks, PipelineInput, PipelineResult, SourceInfo } from '@pipeline/types'
import { planEncode, planExternalTrack } from '@pipeline/plan'
import type { TrackFileInfo } from '@pipeline/probe'
import type { HardwareInfo } from '@pipeline/hardware'
import { createServer } from '../..'
import { openDatabase, type AppDatabase } from '../../db'
import { ServerEvents } from '../../jobs/events'
import { JobRunner, type IncrementalFn, type PipelineFn } from '../../jobs/runner'
import type { Prober } from '../../jobs/enqueue'
import { AppLogger } from '../../logging/logger'
import { JobOutputStore } from '../../logging/job-output'

export const FAKE_BINARIES: Binaries = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', packager: 'packager' }

export const fakeSource = (path: string, over: Partial<SourceInfo['video']> = {}): SourceInfo => ({
  path,
  sizeBytes: 1_000_000,
  durationSeconds: 60,
  containerBitrate: 5_000_000,
  video: {
    index: 0,
    codec: 'h264',
    width: 1920,
    height: 800,
    displayWidth: 1920,
    displayHeight: 800,
    fps: { num: 24, den: 1 },
    bitrate: 4_000_000,
    bitrateEstimated: false,
    pixelFormat: 'yuv420p',
    hdr: null,
    ...over
  },
  audio: [
    { index: 1, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, bitrate: 128000, language: 'spa', title: null, isDefault: true },
    { index: 2, codec: 'dts', channels: 6, channelLayout: '5.1', sampleRate: 48000, bitrate: null, language: 'eng', title: 'Comentarios', isDefault: false }
  ],
  subtitles: [
    { index: 3, codec: 'hdmv_pgs_subtitle', language: 'spa', title: null, isForced: false, isDefault: false, isImage: true },
    { index: 4, codec: 'subrip', language: 'eng', title: null, isForced: true, isDefault: false, isImage: false }
  ]
})

export const fakeProbe: Prober = async (_binaries, path) => fakeSource(path)

// External files: .srt → one subrip stream, .eac3 → one 5.1 E-AC-3 stream, anything else → one stereo AAC stream
export const fakeProbeTracks = async (_binaries: Binaries, path: string): Promise<TrackFileInfo> => {
  if (path.endsWith('.srt')) {
    return { path, audio: [], subtitles: [{ index: 0, codec: 'subrip', language: null, title: null, isForced: false, isDefault: false, isImage: false }] }
  }
  const dolby = path.endsWith('.eac3')
  return {
    path,
    audio: [{ index: 0, codec: dolby ? 'eac3' : 'aac', channels: dolby ? 6 : 2, channelLayout: dolby ? '5.1' : 'stereo', sampleRate: 48000, bitrate: 128000, language: null, title: null, isDefault: false }],
    subtitles: []
  }
}

export interface FakePipelineOptions {
  // Number of progress ticks and the pause between them (lets tests cancel mid-run)
  ticks?: number
  tickMs?: number
  fail?: string
}

// Stand-in for processTitle: same contract, no ffmpeg. Writes a minimal output folder.
export function fakePipeline(options: FakePipelineOptions = {}): PipelineFn {
  const { ticks = 3, tickMs = 5, fail } = options
  return async (_binaries: Binaries, input: PipelineInput, hooks: PipelineHooks = {}): Promise<PipelineResult> => {
    const source = fakeSource(input.sourcePath)
    const plan = planEncode(source, input.plan)
    for (const track of input.externalTracks ?? []) {
      const planned = planExternalTrack(track, await fakeProbeTracks(_binaries, track.path))
      if (Array.isArray(planned)) plan.audio.push(...planned)
      else if ('reason' in planned) plan.skipped.push(planned)
      else plan.subtitles.push(planned)
    }
    hooks.onProgress?.({ step: 'probe', percent: 0 })
    for (let i = 1; i <= ticks; i++) {
      if (hooks.signal?.aborted) throw new Error('abortado')
      await sleep(tickMs)
      hooks.onProgress?.({ step: 'encode', stepPercent: (i / ticks) * 100, percent: 3 + (87 * i) / ticks })
    }
    if (fail) throw new Error(fail)
    hooks.onLog?.('fake pipeline done')

    const outputFolder = join(input.outputRoot, input.titleId)
    mkdirSync(outputFolder, { recursive: true })
    const metadata: PipelineResult['metadata'] = {
      schemaVersion: 1,
      titleId: input.titleId,
      name: input.name,
      durationSeconds: source.durationSeconds,
      standards: input.standards,
      manifests: { hls: 'master.m3u8' },
      dynamicRange: { source: 'sdr', output: 'sdr' },
      source: { path: input.sourcePath, sizeBytes: 1, width: 1920, height: 800, fps: 24, codec: 'h264', bitrate: null },
      segmentDurationSeconds: plan.actualSegmentSeconds,
      renditions: plan.renditions.map((r) => ({
        label: r.label,
        width: r.width,
        height: r.height,
        bitrate: r.maxBitrateKbps * 900,
        maxBitrate: r.maxBitrateKbps * 1000,
        codec: 'h264',
        path: `video/${r.label}`
      })),
      audioTracks: [],
      subtitleTracks: [],
      updatedAt: new Date().toISOString()
    }
    writeFileSync(join(outputFolder, 'metadata.json'), JSON.stringify(metadata))
    hooks.onProgress?.({ step: 'publish', percent: 100 })
    return { titleId: input.titleId, outputFolder, source, plan, metadata }
  }
}

// Stand-in for addToTitle: plans the requested additions and returns them as done
export function fakeIncremental(options: FakePipelineOptions = {}): IncrementalFn {
  const { ticks = 2, tickMs = 5, fail } = options
  return async (_binaries: Binaries, input: IncrementalInput, hooks: PipelineHooks = {}): Promise<PipelineResult> => {
    const source = fakeSource(input.sourcePath)
    const plan = planEncode(source, {
      rungs: input.rungs,
      qualities: input.qualities,
      segmentDurationSeconds: 6,
      audioIndexes: input.audioIndexes,
      subtitleIndexes: input.subtitleIndexes,
      allowNativeFallback: false
    })
    for (const track of input.externalTracks) {
      const planned = planExternalTrack(track, await fakeProbeTracks(_binaries, track.path))
      if (Array.isArray(planned)) plan.audio.push(...planned)
      else if ('reason' in planned) plan.skipped.push(planned)
      else plan.subtitles.push(planned)
    }
    for (let i = 1; i <= ticks; i++) {
      if (hooks.signal?.aborted) throw new Error('abortado')
      await sleep(tickMs)
      hooks.onProgress?.({ step: 'encode', percent: 3 + (87 * i) / ticks })
    }
    if (fail) throw new Error(fail)
    const outputFolder = join(input.outputRoot, input.titleId)
    const metadata: PipelineResult['metadata'] = {
      schemaVersion: 1,
      titleId: input.titleId,
      name: input.name,
      durationSeconds: source.durationSeconds,
      standards: ['hls'],
      manifests: { hls: 'master.m3u8' },
      dynamicRange: { source: 'sdr', output: 'sdr' },
      source: { path: input.sourcePath, sizeBytes: 1, width: 1920, height: 800, fps: 24, codec: 'h264', bitrate: null },
      segmentDurationSeconds: 6,
      renditions: plan.renditions.map((r) => ({ label: r.label, width: r.width, height: r.height, bitrate: 1, maxBitrate: 1, codec: 'h264', path: `video/${r.label}` })),
      audioTracks: [],
      subtitleTracks: [],
      updatedAt: new Date().toISOString()
    }
    hooks.onProgress?.({ step: 'publish', percent: 100 })
    return { titleId: input.titleId, outputFolder, source, plan, metadata }
  }
}

export interface TestServer {
  app: FastifyInstance
  db: AppDatabase
  events: ServerEvents
  runner: JobRunner
  log: AppLogger
  jobOutput: JobOutputStore
  allowedOrigins: string[]
}

export async function createTestServer(
  options: { pipeline?: PipelineFn; incremental?: IncrementalFn; outputFolder?: string; concurrency?: number; hardware?: HardwareInfo; probe?: Prober } = {}
): Promise<TestServer> {
  const db = openDatabase(':memory:')
  const events = new ServerEvents()
  const log = new AppLogger()
  log.attachStore(db.repos.logs, events)
  const jobOutput = new JobOutputStore(mkdtempSync(join(tmpdir(), 'lp-job-logs-')))
  const runner = new JobRunner({
    db: db.db,
    repos: db.repos,
    events,
    binaries: FAKE_BINARIES,
    pipeline: options.pipeline ?? fakePipeline(),
    incremental: options.incremental ?? fakeIncremental(),
    // Tests run one job at a time unless they ask for hardware-derived concurrency
    concurrency: options.hardware ? undefined : (options.concurrency ?? 1),
    hardware: options.hardware ?? null,
    log,
    jobOutput
  })
  if (options.outputFolder) db.repos.settings.updateConfig({ outputFolder: options.outputFolder })
  // As in production: recovery first, then the routes may notify()
  runner.start()

  const allowedOrigins = ['app://renderer']
  const app = await createServer({
    host: '127.0.0.1',
    port: 0,
    version: 'test',
    context: { db: db.db, repos: db.repos, events, runner, log, jobOutput, binaries: FAKE_BINARIES, hardware: options.hardware ?? null, probe: options.probe ?? fakeProbe, probeTracks: fakeProbeTracks, checkDiskSpace: false },
    allowedOrigins,
    logLevel: 'silent'
  })
  app.addHook('onClose', async () => {
    await runner.stop()
    db.close()
    rmSync(jobOutput.dir, { recursive: true, force: true })
  })
  return { app, db, events, runner, log, jobOutput, allowedOrigins }
}
