import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Job, Title, TrackOverrides } from '@shared/model'
import { planEncode, unsupportedSourceReason } from '@pipeline/plan'
import { ProbeError, probeSource } from '@pipeline/probe'
import { ProcessError } from '@pipeline/exec'
import type { Binaries, SourceInfo } from '@pipeline/types'
import type { Repositories } from '../db/repositories'
import type { TitlePatch } from '../db/repositories/titles'
import { badRequest, conflict } from '../errors'
import { planOptionsOf, snapshotJobConfig, type ConfigOverrides } from './config'
import { estimatePeakBytes, formatBytes, freeBytes } from './estimate'
import type { ServerEvents } from './events'
import { sourceHash } from './source-hash'
import { parseTrackOverrides } from './track-overrides'

export type Prober = (binaries: Binaries, path: string) => Promise<SourceInfo>

// What a title remembers about its source file
export function sourceFields(source: SourceInfo): TitlePatch {
  return {
    source_width: source.video.displayWidth,
    source_height: source.video.displayHeight,
    source_video_bitrate: source.video.bitrate,
    source_fps: source.video.fps.num / source.video.fps.den,
    source_video_codec: source.video.codec,
    source_hdr: source.video.hdr?.transfer ?? null,
    duration_seconds: source.durationSeconds
  }
}

export interface EnqueueDeps {
  repos: Repositories
  events: ServerEvents
  binaries: Binaries
  probe?: Prober
  // Disabled in tests that run on tiny temp folders
  checkDiskSpace?: boolean
}

export interface EnqueueInput {
  sourcePath: string
  sourceManaged?: boolean
  titleId?: string
  name?: string
  overrides?: ConfigOverrides
  // Names, languages and default tracks the consumer wants over the source's
  trackOverrides?: TrackOverrides | null
}

// POST /titles without the HTTP: validates, probes, checks disk and creates the
// title + initial job. Throws HttpError for every user-facing failure.
export async function enqueueTitle(deps: EnqueueDeps, input: EnqueueInput): Promise<{ title: Title; job: Job }> {
  const { repos, events } = deps
  const config = snapshotJobConfig(repos.settings.getConfig(), input.overrides)
  const outputInfo = await stat(config.outputFolder).catch(() => undefined)
  if (!outputInfo?.isDirectory()) {
    throw conflict(`La carpeta de salida ya no existe: ${config.outputFolder}. Elige otra en Configuración.`)
  }

  if (!isAbsolute(input.sourcePath)) throw badRequest('sourcePath debe ser una ruta absoluta')
  const info = await stat(input.sourcePath).catch(() => undefined)
  if (!info) throw badRequest(`El archivo no existe: ${input.sourcePath}`)
  if (!info.isFile()) throw badRequest(`La ruta no es un archivo: ${input.sourcePath}`)

  const existing = repos.titles.findBySourcePath(input.sourcePath)
  if (existing) {
    throw conflict(`El archivo ya está registrado como título ${existing.id}`, { titleId: existing.id })
  }

  const probe = deps.probe ?? probeSource
  const source = await probe(deps.binaries, input.sourcePath).catch((error: unknown) => {
    if (error instanceof ProbeError || error instanceof ProcessError) {
      throw badRequest(`No se pudo analizar el archivo: ${error.message}`)
    }
    throw error
  })

  const unsupported = unsupportedSourceReason(source)
  if (unsupported) throw badRequest(`El archivo no se puede procesar: ${unsupported}`)
  const trackOverrides = parseTrackOverrides(input.trackOverrides, {
    audio: source.audio.map((a) => a.index),
    subtitles: source.subtitles.map((s) => s.index)
  })

  const plan = planEncode(source, planOptionsOf(config))
  if (deps.checkDiskSpace !== false) {
    const required = estimatePeakBytes(source, plan)
    const free = await freeBytes(config.outputFolder)
    if (free < required) {
      throw badRequest(
        `Espacio insuficiente en ${config.outputFolder}: se necesitan ~${formatBytes(required)} y hay ${formatBytes(free)} libres`,
        { requiredBytes: required, freeBytes: free }
      )
    }
  }

  const id = input.titleId ?? randomUUID()
  repos.titles.create({
    id,
    name: input.name?.trim() || basename(input.sourcePath, extname(input.sourcePath)),
    source_path: input.sourcePath,
    source_managed: input.sourceManaged ?? false,
    output_folder: join(config.outputFolder, id)
  })
  const title = repos.titles.update(id, {
    source_hash: await sourceHash(input.sourcePath),
    ...sourceFields(source),
    ...(trackOverrides ? { track_overrides: trackOverrides } : {})
  })!
  const job = repos.jobs.create({ title_id: id, tipo: 'inicial', config })

  events.emit({ type: 'title.updated', title })
  events.emit({ type: 'job.updated', job })
  return { title, job }
}
