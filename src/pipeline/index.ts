import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { commandEvent, emit, encodedEvent, externalsEvent, planEvents, publishedEvent, sourceEvent, subtitlesEvent } from './describe'
import { buildFfmpegArgs, extractSubtitles, runFfmpeg, type EncodeOutputs } from './ffmpeg'
import { DASH_MANIFEST, MASTER_PLAYLIST, METADATA_FILE, WORK_DIR, audioDir, renditionDir, subtitleDir } from './layout'
import { measureBandwidth, mergeMasterPlaylists, mergeMetadata, mergeMpds, replaceFileAtomic } from './manifests'
import { buildMetadata, writeJsonAtomic } from './metadata'
import { ENC_DIR, PKG_DIR, buildPackagerArgs, runPackager } from './packager'
import { planEncode, planExternalTrack, unsupportedSourceReason } from './plan'
import { probeSource, probeTrackFile, type TrackFileInfo } from './probe'
import type {
  Binaries,
  EncodePlan,
  ExternalTrack,
  IncrementalInput,
  PipelineHooks,
  PipelineInput,
  PipelineResult,
  PipelineStep,
  ProgressEvent,
  SourceInfo,
  TitleMetadata
} from './types'

export { resolveBinaries, BinaryNotFoundError } from './binaries'
export { ProcessError } from './exec'
export { ProbeError, probeSource, probeTrackFile } from './probe'
export { planEncode, unsupportedSourceReason } from './plan'
export * from './types'

export class PipelineError extends Error {
  constructor(
    public readonly step: PipelineStep,
    message: string
  ) {
    super(message)
    this.name = 'PipelineError'
  }
}

// Share of the overall progress bar given to each step
const STEP_RANGES: Record<PipelineStep, [number, number]> = {
  probe: [0, 2],
  plan: [2, 3],
  encode: [3, 90],
  package: [90, 99],
  publish: [99, 100]
}

type Reporter = (step: PipelineStep, stepPercent?: number, message?: string) => void

function reporter(hooks: PipelineHooks): Reporter {
  return (step, stepPercent, message) => {
    const [from, to] = STEP_RANGES[step]
    const percent = stepPercent === undefined ? from : from + ((to - from) * stepPercent) / 100
    hooks.onProgress?.({ step, stepPercent, percent: Math.round(percent * 10) / 10, message } satisfies ProgressEvent)
  }
}

interface WorkDirs {
  workDir: string
  encDir: string
  pkgDir: string
}

// Short work folder: Shaka Packager is not long-path aware on Windows (260 chars)
async function prepareWorkDirs(outputRoot: string, titleId: string): Promise<WorkDirs> {
  const workDir = join(outputRoot, WORK_DIR, titleId.replace(/-/g, '').slice(0, 12))
  const dirs = { workDir, encDir: join(workDir, ENC_DIR), pkgDir: join(workDir, PKG_DIR) }
  await rm(workDir, { recursive: true, force: true })
  await mkdir(dirs.encDir, { recursive: true })
  await mkdir(dirs.pkgDir, { recursive: true })
  return dirs
}

async function discardWorkDirs(dirs: WorkDirs): Promise<void> {
  await rm(dirs.workDir, { recursive: true, force: true }).catch(() => undefined)
  await rmdir(dirname(dirs.workDir)).catch(() => undefined)
}

// probe → plan → encode → package → publish. Everything is written under
// <outputRoot>/.tmp/<id>/ and only renamed to <outputRoot>/<titleId>/ at the end,
// so a failure never leaves a half-built title where consumers can see it.
export async function processTitle(
  binaries: Binaries,
  input: PipelineInput,
  hooks: PipelineHooks = {}
): Promise<PipelineResult> {
  const report = reporter(hooks)
  const finalDir = join(input.outputRoot, input.titleId)
  if (existsSync(finalDir) && !input.replaceExisting) {
    throw new PipelineError('publish', `La carpeta de salida ya existe: ${finalDir}`)
  }
  const dirs = await prepareWorkDirs(input.outputRoot, input.titleId)

  try {
    report('probe')
    const source = await probeSource(binaries, input.sourcePath, hooks.signal)
    emit(hooks, sourceEvent(source))
    const externals = await probeExternalTracks(binaries, input.externalTracks ?? [], hooks.signal)
    const externalsInfo = externalsEvent(externals)
    if (externalsInfo) emit(hooks, externalsInfo)

    report('plan')
    const unsupported = unsupportedSourceReason(source)
    if (unsupported) throw new PipelineError('plan', unsupported)
    const plan = planEncode(source, input.plan)
    addExternalTracks(plan, input.externalTracks ?? [], externals)
    if (plan.renditions.length === 0) {
      const reasons = plan.skipped.filter((s) => s.kind === 'rendition').map((s) => `${s.id}: ${s.reason}`)
      throw new PipelineError('plan', `Ninguna calidad configurada aplica a este origen (${reasons.join('; ')})`)
    }
    logPlan(plan, hooks)
    assertPathLengths(dirs.workDir, plan)

    const outputs = await encode(binaries, source, plan, dirs, input, hooks, report)
    await packageStreams(binaries, source, plan, dirs, input.standards, true, hooks, report)

    const metadata = await buildMetadata({ titleId: input.titleId, name: input.name, standards: input.standards, source, plan, outputs })
    await writeJsonAtomic(join(dirs.pkgDir, METADATA_FILE), metadata)

    report('publish', 0)
    await mkdir(dirname(finalDir), { recursive: true })
    const replaced = existsSync(finalDir)
    if (replaced) await swapFolders(dirs.pkgDir, finalDir)
    else await rename(dirs.pkgDir, finalDir)
    await discardWorkDirs(dirs)
    emit(hooks, await publishedEvent(finalDir, { replaced, standards: input.standards, manifests: metadata.manifests }))
    report('publish', 100)

    return { titleId: input.titleId, outputFolder: finalDir, source, plan, metadata }
  } catch (error) {
    await discardWorkDirs(dirs)
    throw error
  }
}

// Adds qualities and tracks to a published title without touching what is there:
// new streams are packaged alone, their folders moved into place, and only then
// are the manifests and metadata.json replaced atomically with merged versions.
export async function addToTitle(
  binaries: Binaries,
  input: IncrementalInput,
  hooks: PipelineHooks = {}
): Promise<PipelineResult> {
  const report = reporter(hooks)
  const titleDir = join(input.outputRoot, input.titleId)
  const published = await readPublishedMetadata(titleDir)
  const dirs = await prepareWorkDirs(input.outputRoot, input.titleId)

  try {
    report('probe')
    const source = await probeSource(binaries, input.sourcePath, hooks.signal)
    emit(hooks, sourceEvent(source))
    const externals = await probeExternalTracks(binaries, input.externalTracks, hooks.signal)
    const externalsInfo = externalsEvent(externals)
    if (externalsInfo) emit(hooks, externalsInfo)

    report('plan')
    // Same GOP as the published segments: the actual segment length is gop / fps exactly
    const plan = planEncode(source, {
      rungs: input.rungs,
      qualities: input.qualities,
      segmentDurationSeconds: published.segmentDurationSeconds,
      audioIndexes: input.audioIndexes,
      subtitleIndexes: input.subtitleIndexes,
      allowNativeFallback: false
    })
    addExternalTracks(plan, input.externalTracks, externals)
    assertIncrementalPlan(plan, input, published)
    logPlan(plan, hooks)
    assertPathLengths(dirs.workDir, plan)

    const outputs = await encode(binaries, source, plan, dirs, input, hooks, report)
    await packageStreams(binaries, source, plan, dirs, published.standards, false, hooks, report)
    const addition = await buildMetadata({ titleId: input.titleId, name: input.name, standards: published.standards, source, plan, outputs })

    report('publish', 0)
    for (const dir of [
      ...plan.renditions.map((r) => renditionDir(r.label)),
      ...plan.audio.map(audioDir),
      ...plan.subtitles.map(subtitleDir)
    ]) {
      await mkdir(dirname(join(titleDir, dir)), { recursive: true })
      await rename(join(dirs.pkgDir, dir), join(titleDir, dir))
    }
    if (published.standards.includes('hls')) {
      const merged = await mergeMasterPlaylists(
        await readFile(join(titleDir, MASTER_PLAYLIST), 'utf8'),
        await readFile(join(dirs.pkgDir, MASTER_PLAYLIST), 'utf8'),
        (uri) => measureBandwidth(join(titleDir, uri))
      )
      await replaceFileAtomic(join(titleDir, MASTER_PLAYLIST), merged)
    }
    if (published.standards.includes('dash')) {
      const merged = mergeMpds(await readFile(join(titleDir, DASH_MANIFEST), 'utf8'), await readFile(join(dirs.pkgDir, DASH_MANIFEST), 'utf8'))
      await replaceFileAtomic(join(titleDir, DASH_MANIFEST), merged)
    }
    const metadata = mergeMetadata(published, addition)
    await replaceFileAtomic(join(titleDir, METADATA_FILE), JSON.stringify(metadata, null, 2) + '\n')
    await discardWorkDirs(dirs)
    emit(hooks, {
      level: 'info',
      message: `Añadido al título y manifiestos actualizados: ${[...plan.renditions.map((r) => `calidad ${r.label}`), ...plan.audio.map((a) => `audio ${audioDir(a)}`), ...plan.subtitles.map((s) => `subtítulo ${subtitleDir(s)}`)].join(', ')}`,
      context: {
        outputFolder: titleDir,
        standards: published.standards,
        added: { renditions: plan.renditions.map((r) => r.label), audio: plan.audio.map(audioDir), subtitles: plan.subtitles.map(subtitleDir) }
      }
    })
    report('publish', 100)

    return { titleId: input.titleId, outputFolder: titleDir, source, plan, metadata }
  } catch (error) {
    await discardWorkDirs(dirs)
    throw error
  }
}

export async function readPublishedMetadata(titleDir: string): Promise<TitleMetadata> {
  try {
    return JSON.parse(await readFile(join(titleDir, METADATA_FILE), 'utf8')) as TitleMetadata
  } catch {
    throw new PipelineError('plan', `El título no está publicado (falta ${METADATA_FILE} en ${titleDir}); usa el reprocesado completo`)
  }
}

async function probeExternalTracks(binaries: Binaries, tracks: ExternalTrack[], signal?: AbortSignal): Promise<Map<string, TrackFileInfo | null>> {
  const infos = new Map<string, TrackFileInfo | null>()
  for (const track of tracks) {
    if (infos.has(track.path)) continue
    infos.set(track.path, await probeTrackFile(binaries, track.path, signal).catch(() => null))
  }
  return infos
}

function addExternalTracks(plan: EncodePlan, tracks: ExternalTrack[], infos: Map<string, TrackFileInfo | null>): void {
  for (const track of tracks) {
    const planned = planExternalTrack(track, infos.get(track.path) ?? null)
    if (Array.isArray(planned)) plan.audio.push(...planned)
    else if ('reason' in planned) plan.skipped.push(planned)
    else plan.subtitles.push(planned)
  }
}

function assertIncrementalPlan(plan: EncodePlan, input: IncrementalInput, published: TitleMetadata): void {
  const missing = input.qualities.filter((label) => !plan.renditions.some((r) => r.label === label))
  if (missing.length > 0) {
    const reasons = plan.skipped.filter((s) => s.kind === 'rendition').map((s) => `${s.id}: ${s.reason}`)
    throw new PipelineError('plan', `No se puede generar ${missing.join(', ')}: ${reasons.join('; ') || 'calidad no aplicable'}`)
  }
  const clashes = [
    ...plan.renditions.filter((r) => published.renditions.some((p) => p.label === r.label)).map((r) => `calidad ${r.label}`),
    ...plan.audio.filter((a) => published.audioTracks.some((p) => p.path === audioDir(a))).map((a) => `audio ${audioDir(a)}`),
    ...plan.subtitles.filter((s) => published.subtitleTracks.some((p) => p.path === subtitleDir(s))).map((s) => `subtítulo ${subtitleDir(s)}`)
  ]
  if (clashes.length > 0) throw new PipelineError('plan', `Ya existe en el título: ${clashes.join(', ')}`)
  if (plan.renditions.length + plan.audio.length + plan.subtitles.length === 0) {
    const reasons = plan.skipped.map((s) => `${s.kind} ${s.id}: ${s.reason}`)
    throw new PipelineError('plan', `Nada que agregar${reasons.length ? ` (${reasons.join('; ')})` : ''}`)
  }
}

function logPlan(plan: EncodePlan, hooks: PipelineHooks): void {
  for (const item of plan.skipped) hooks.onLog?.(`omitido ${item.kind} ${item.id}: ${item.reason}`)
  for (const r of plan.renditions) {
    if (r.nativeFallback) hooks.onLog?.(`ninguna calidad configurada aplica: se genera ${r.label} a resolución nativa (${r.width}×${r.height})`)
  }
  for (const event of planEvents(plan)) emit(hooks, event)
}

async function encode(
  binaries: Binaries,
  source: SourceInfo,
  plan: EncodePlan,
  dirs: WorkDirs,
  input: { videoEncoder?: PipelineInput['videoEncoder'] },
  hooks: PipelineHooks,
  report: Reporter
): Promise<EncodeOutputs> {
  report('encode', 0)
  const subtitles = await extractSubtitles(binaries, source, plan.subtitles, dirs.encDir, { onLog: hooks.onLog, signal: hooks.signal })
  plan.subtitles = subtitles.extracted
  plan.skipped.push(...subtitles.failed)
  for (const item of subtitles.failed) hooks.onLog?.(`omitido subtitle ${item.id}: ${item.reason}`)
  for (const event of subtitlesEvent(subtitles)) emit(hooks, event)

  const { args, outputs } = buildFfmpegArgs(source, plan, dirs.encDir, input.videoEncoder)
  if (plan.renditions.length + plan.audio.length > 0) {
    hooks.onLog?.(`ffmpeg ${args.join(' ')}`)
    emit(hooks, commandEvent('ffmpeg', args, { encoder: input.videoEncoder?.kind ?? 'libx264' }))
    await runFfmpeg(binaries, args, source.durationSeconds, {
      onProgress: (p) => report('encode', p.percent),
      onLog: hooks.onLog,
      signal: hooks.signal
    })
    emit(hooks, await encodedEvent(outputs))
  }
  report('encode', 100)
  return outputs
}

async function packageStreams(
  binaries: Binaries,
  source: SourceInfo,
  plan: EncodePlan,
  dirs: WorkDirs,
  standards: TitleMetadata['standards'],
  markDefaults: boolean,
  hooks: PipelineHooks,
  report: Reporter
): Promise<void> {
  report('package', 0)
  const args = buildPackagerArgs(plan, standards, { markDefaults })
  hooks.onLog?.(`packager ${args.join(' ')}`)
  const streams = plan.renditions.length + plan.audio.length + plan.subtitles.length
  const expectedSegments = Math.ceil(source.durationSeconds / plan.actualSegmentSeconds) * streams
  emit(hooks, commandEvent('packager', args, { workDir: dirs.workDir, standards, streams, expectedSegments }))
  await runPackager(binaries, args, dirs.workDir, expectedSegments, {
    onProgress: (percent) => report('package', percent),
    onLog: hooks.onLog,
    signal: hooks.signal
  })
  emit(hooks, {
    level: 'info',
    message: `Empaquetado terminado: ${streams} flujo(s) en ${standards.join(' + ').toUpperCase()}, ~${expectedSegments} segmentos`,
    context: { standards, streams, expectedSegments }
  })
  report('package', 100)
}

// Full reprocess: the published folder is swapped for the new one with two renames.
// Windows has no atomic directory exchange, so there is a sub-millisecond window
// with no folder; players mid-stream keep requesting the same segment names.
async function swapFolders(fresh: string, target: string): Promise<void> {
  const old = `${target}.old`
  await rm(old, { recursive: true, force: true })
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(target, old)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code ?? '')) {
        throw new PipelineError('publish', `No se pudo reemplazar la carpeta publicada (${code}): hay archivos en uso en ${target}`)
      }
      await sleep(100 * attempt)
    }
  }
  await rename(fresh, target)
  await rm(old, { recursive: true, force: true }).catch(() => undefined)
}

// Shaka writes "<dir>/packager-tempfile-<hex>" next to each playlist; on Windows the
// whole path must stay under MAX_PATH or packaging fails halfway through.
const WINDOWS_MAX_PATH = 259
const PACKAGER_TEMPFILE_LENGTH = 'packager-tempfile-0000-0000000000000000-0'.length

function assertPathLengths(workDir: string, plan: EncodePlan): void {
  if (process.platform !== 'win32') return
  const dirs = [
    ...plan.renditions.map((r) => renditionDir(r.label)),
    ...plan.audio.map(audioDir),
    ...plan.subtitles.map(subtitleDir)
  ]
  if (dirs.length === 0) return
  const longest = Math.max(...dirs.map((dir) => join(workDir, PKG_DIR, dir).length + 1 + PACKAGER_TEMPFILE_LENGTH))
  if (longest > WINDOWS_MAX_PATH) {
    throw new PipelineError(
      'plan',
      `La carpeta de salida es demasiado larga para Windows: las rutas de trabajo llegarían a ${longest} caracteres (máximo ${WINDOWS_MAX_PATH}). Usa una carpeta de salida más corta.`
    )
  }
}
