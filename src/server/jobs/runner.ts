import type { DatabaseSync } from 'node:sqlite'
import { basename } from 'node:path'
import type { Job } from '@shared/model'
import { PipelineError, addToTitle, processTitle } from '@pipeline/index'
import { SOFTWARE_ENCODER, encoderSpec, isHardwareEncoder, type EncoderKind } from '@pipeline/encoders'
import { ProcessError } from '@pipeline/exec'
import type { HardwareInfo } from '@pipeline/hardware'
import { audioTrackId, subtitleTrackId } from '@pipeline/layout'
import type { Binaries, ExternalTrack, PipelineHooks, PipelineResult, ProgressEvent, VideoEncoderOptions } from '@pipeline/types'
import type { Repositories } from '../db/repositories'
import { formatDuration } from '../logging/format'
import type { JobOutputStore } from '../logging/job-output'
import { AppLogger, errorContext } from '../logging/logger'
import { computeConcurrency, resolveEncoder } from './concurrency'
import { parseJobConfig, type JobConfig } from './config'
import type { ServerEvents } from './events'
import { recordIncremental, recordResult } from './record'
import { sourceHash } from './source-hash'

export type PipelineFn = typeof processTitle
export type IncrementalFn = typeof addToTitle

// Extra fields incremental jobs carry in config_json
export interface ReprocessConfig extends JobConfig {
  audioIndexes?: number[]
  subtitleIndexes?: number[]
  externalTracks?: ExternalTrack[]
}

export interface RunnerDeps {
  db: DatabaseSync
  repos: Repositories
  events: ServerEvents
  binaries: Binaries
  pipeline?: PipelineFn
  incremental?: IncrementalFn
  // Fixed number, or derived from the detected hardware and the current config
  concurrency?: number
  hardware?: HardwareInfo | null
  log?: AppLogger
  // Where each job's full ffmpeg / packager output goes; absent in tests
  jobOutput?: JobOutputStore
}

// A job interrupted this many times by a crash is given up on
export const MAX_ATTEMPTS = 3
const CANCELLED_MESSAGE = 'Cancelado por el usuario'
const INTERRUPTED_MESSAGE = `Interrumpido ${MAX_ATTEMPTS} veces por cierres inesperados`

interface RunningJob {
  controller: AbortController
  done: Promise<void>
}

// Persistent FIFO queue on the jobs table: this class only decides what runs
// now, everything else (order, retries, progress) survives in SQLite.
export class JobRunner {
  private readonly running = new Map<string, RunningJob>()
  private readonly pipeline: PipelineFn
  private readonly incremental: IncrementalFn
  private readonly log: AppLogger
  private started = false
  private stopping = false

  constructor(private readonly deps: RunnerDeps) {
    this.pipeline = deps.pipeline ?? processTitle
    this.incremental = deps.incremental ?? addToTitle
    this.log = deps.log ?? AppLogger.silent()
  }

  // Recovery must run before any job starts, so notify() is inert until then
  start(): void {
    if (this.started) return
    this.started = true
    this.recover()
    this.tick()
  }

  // Aborts running jobs and leaves them queued so they resume on the next start
  async stop(): Promise<void> {
    this.stopping = true
    for (const [id, job] of this.running) {
      const row = this.deps.repos.jobs.get(id)
      if (row) {
        this.deps.repos.jobs.update(id, {
          status: 'queued',
          progress: 0,
          current_step: null,
          started_at: null,
          attempts: Math.max(0, row.attempts - 1)
        })
        this.deps.repos.titles.update(row.title_id, { status: 'queued' })
        this.log.info('jobs', 'Job interrumpido por el cierre de la aplicación; se reanudará desde cero al arrancar', {
          jobId: id,
          titleId: row.title_id,
          context: { step: row.current_step, progress: row.progress }
        })
      }
      job.controller.abort()
    }
    await Promise.allSettled([...this.running.values()].map((j) => j.done))
  }

  notify(): void {
    this.tick()
  }

  // Jobs allowed to run at once right now: a config change takes effect on the next tick
  concurrency(): number {
    if (this.deps.concurrency !== undefined) return this.deps.concurrency
    return computeConcurrency(this.deps.repos.settings.getConfig(), this.deps.hardware ?? null)
  }

  hasRunning(): boolean {
    return this.running.size > 0
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.deps.repos.jobs.get(jobId)
    if (!job) return false

    const active = this.running.get(jobId)
    if (active) {
      active.controller.abort()
      await active.done
      return true
    }
    if (job.status !== 'queued') return false

    this.finish(job.id, 'cancelled', CANCELLED_MESSAGE)
    this.log.info('jobs', 'Job cancelado por el usuario (estaba en cola)', { jobId: job.id, titleId: job.title_id, context: { tipo: job.tipo } })
    return true
  }

  async cancelForTitle(titleId: string): Promise<void> {
    for (const job of this.deps.repos.jobs.listByTitle(titleId)) {
      if (job.status === 'queued' || job.status === 'running') await this.cancel(job.id)
    }
  }

  private recover(): void {
    for (const job of this.deps.repos.jobs.list({ status: 'running' })) {
      if (job.attempts >= MAX_ATTEMPTS) {
        this.finish(job.id, 'error', INTERRUPTED_MESSAGE)
        this.log.error('jobs', `Job abandonado: interrumpido ${job.attempts} veces por cierres inesperados`, {
          jobId: job.id,
          titleId: job.title_id,
          context: { tipo: job.tipo, attempts: job.attempts, lastStep: job.current_step, progress: job.progress }
        })
        continue
      }
      this.deps.repos.jobs.update(job.id, { status: 'queued', progress: 0, current_step: null, started_at: null })
      this.deps.repos.titles.update(job.title_id, { status: 'queued' })
      this.log.warn('jobs', `Job reencolado tras un cierre inesperado (intento ${job.attempts} de ${MAX_ATTEMPTS})`, {
        jobId: job.id,
        titleId: job.title_id,
        context: { tipo: job.tipo, attempts: job.attempts, lastStep: job.current_step, progress: job.progress }
      })
    }
  }

  private tick(): void {
    if (!this.started || this.stopping) return
    while (this.running.size < this.concurrency()) {
      const next = this.deps.repos.jobs.nextQueued()
      if (!next) return
      const controller = new AbortController()
      const done = this.execute(next, controller.signal).finally(() => {
        this.running.delete(next.id)
        this.tick()
      })
      this.running.set(next.id, { controller, done })
    }
  }

  private async execute(queued: Job, signal: AbortSignal): Promise<void> {
    const { repos, events, binaries } = this.deps
    const title = repos.titles.get(queued.title_id)
    if (!title) {
      this.finish(queued.id, 'error', 'El título ya no existe')
      return
    }

    const job = repos.jobs.update(queued.id, {
      status: 'running',
      progress: 0,
      current_step: 'probe',
      error: null,
      attempts: queued.attempts + 1,
      started_at: new Date().toISOString()
    })!
    events.emit({ type: 'job.updated', job })
    events.emit({ type: 'title.updated', title: repos.titles.update(title.id, { status: 'processing', error: null })! })

    const config = parseJobConfig(job.config_json) as ReprocessConfig
    const ref = { jobId: job.id, titleId: title.id }
    const startedAt = Date.now()
    const output = this.deps.jobOutput?.open(job.id)
    this.log.info('jobs', `Job ${job.tipo} iniciado para «${title.name}» (intento ${job.attempts} de ${MAX_ATTEMPTS})`, {
      ...ref,
      context: {
        tipo: job.tipo,
        attempt: job.attempts,
        sourcePath: title.source_path,
        outputFolder: config.outputFolder,
        standards: config.standards,
        qualities: config.qualities,
        segmentDurationSeconds: config.segmentDurationSeconds,
        encoderPreference: config.encoder,
        ...(config.audioIndexes?.length ? { audioIndexes: config.audioIndexes } : {}),
        ...(config.subtitleIndexes?.length ? { subtitleIndexes: config.subtitleIndexes } : {}),
        ...(config.externalTracks?.length ? { externalTracks: config.externalTracks } : {}),
        ...(output ? { outputLog: this.deps.jobOutput!.path(job.id) } : {})
      }
    })

    let lastPersisted = -1
    let lastStep: string | null = null
    let stepStartedAt = startedAt
    let lastDecile = -1
    const stepDurations: Record<string, number> = {}
    const closeStep = (): void => {
      if (lastStep) stepDurations[lastStep] = (stepDurations[lastStep] ?? 0) + (Date.now() - stepStartedAt)
    }
    const hooks: PipelineHooks = {
      signal,
      onLog: (line) => {
        output?.write(line)
        events.emit({ type: 'job.log', jobId: job.id, line })
      },
      onEvent: (event) => this.log.log(event.level, 'pipeline', event.message, { ...ref, context: event.context ?? null }),
      onProgress: (event: ProgressEvent) => {
        // A dying process can still report once after abort/stop; the row is no longer ours
        if (signal.aborted || this.stopping) return
        const stepChanged = event.step !== lastStep
        if (!stepChanged && event.percent - lastPersisted < 0.5) return
        if (stepChanged) {
          closeStep()
          if (lastStep) {
            this.log.info('jobs', `Paso ${lastStep} terminado en ${formatDuration(stepDurations[lastStep]!)}; empieza ${event.step}`, {
              ...ref,
              context: { step: lastStep, ms: stepDurations[lastStep], next: event.step }
            })
          }
          stepStartedAt = Date.now()
        }
        lastPersisted = event.percent
        lastStep = event.step
        const decile = Math.floor(event.percent / 10)
        if (decile > lastDecile && event.percent < 100) {
          lastDecile = decile
          this.log.debug('jobs', `Progreso ${Math.round(event.percent)} % (${event.step})`, { ...ref, context: { percent: event.percent, step: event.step, stepPercent: event.stepPercent ?? null } })
        }
        const updated = repos.jobs.update(job.id, { progress: event.percent, current_step: event.step })
        if (updated) events.emit({ type: 'job.progress', job: updated })
      }
    }
    const encoder = resolveEncoder(config.encoder ?? 'auto', this.deps.hardware ?? null)

    try {
      // Jobs are only ever queued for titles with a source; an imported title must link one first
      if (!title.source_path) throw new Error('El título no tiene archivo de origen vinculado')
      const sourcePath = title.source_path
      const base = { titleId: title.id, name: title.name, sourcePath, outputRoot: config.outputFolder }
      let result: PipelineResult
      if (job.tipo === 'inicial' || job.tipo === 'reprocesar_completo') {
        result = await this.withSoftwareFallback(job, encoder, hooks, (videoEncoder) =>
          this.pipeline(
            binaries,
            {
              ...base,
              standards: config.standards,
              plan: { rungs: config.rungs, qualities: config.qualities, segmentDurationSeconds: config.segmentDurationSeconds },
              externalTracks: config.externalTracks,
              replaceExisting: job.tipo === 'reprocesar_completo',
              videoEncoder
            },
            hooks
          )
        )
        recordResult(repos, this.deps.db, result)
        // A full reprocess is the one job allowed to adopt a replaced source file
        if (job.tipo === 'reprocesar_completo') repos.titles.update(title.id, { source_hash: await sourceHash(sourcePath) })
      } else {
        // Mixing renditions of two different files would corrupt the title
        if (title.source_hash && (await sourceHash(sourcePath)) !== title.source_hash) {
          throw new Error('El archivo de origen cambió desde el procesado inicial; usa el reprocesado completo')
        }
        result = await this.withSoftwareFallback(job, encoder, hooks, (videoEncoder) =>
          this.incremental(
            binaries,
            {
              ...base,
              rungs: config.rungs,
              qualities: job.tipo === 'agregar_calidad' ? config.qualities : [],
              audioIndexes: config.audioIndexes ?? [],
              subtitleIndexes: config.subtitleIndexes ?? [],
              externalTracks: config.externalTracks ?? [],
              videoEncoder
            },
            hooks
          )
        )
        recordIncremental(repos, this.deps.db, result)
      }
      this.finish(job.id, 'done', null)
      closeStep()
      const durationMs = Date.now() - startedAt
      this.log.info('jobs', `Job ${job.tipo} completado en ${formatDuration(durationMs)} → ${result.outputFolder}`, {
        ...ref,
        context: {
          outputFolder: result.outputFolder,
          durationMs,
          steps: stepDurations,
          renditions: result.plan.renditions.map((r) => r.label),
          audio: result.plan.audio.map(audioTrackId),
          subtitles: result.plan.subtitles.map(subtitleTrackId),
          skipped: result.plan.skipped
        }
      })
    } catch (error) {
      // stop() already re-queued the job; leave its row alone
      if (this.stopping) return
      const cancelled = signal.aborted
      const message = cancelled ? CANCELLED_MESSAGE : error instanceof Error ? error.message : String(error)
      this.finish(job.id, cancelled ? 'cancelled' : 'error', message)
      const step = error instanceof PipelineError ? error.step : (lastStep ?? 'probe')
      if (cancelled) {
        this.log.info('jobs', `Job cancelado por el usuario durante ${step}`, { ...ref, context: { step, progress: Math.max(0, lastPersisted) } })
      } else {
        this.log.error('jobs', `Job ${job.tipo} falló en ${step}: ${describeFailure(error, message)}`, {
          ...ref,
          context: {
            step,
            progress: Math.max(0, lastPersisted),
            durationMs: Date.now() - startedAt,
            ...errorContext(error),
            // The last lines ffmpeg / the packager printed, in order
            output: output?.tail() ?? []
          }
        })
      }
    } finally {
      output?.close()
      this.deps.jobOutput?.prune()
    }
  }

  // A hardware encoder that was detected at startup can still fail at run time
  // (driver hiccup, session limit): the job is retried once on the CPU.
  private async withSoftwareFallback(
    job: Job,
    encoder: EncoderKind,
    hooks: PipelineHooks,
    attempt: (videoEncoder: VideoEncoderOptions) => Promise<PipelineResult>
  ): Promise<PipelineResult> {
    const ref = { jobId: job.id, titleId: job.title_id }
    this.log.info('jobs', `Codificador de video: ${encoderSpec(encoder).label}`, { ...ref, context: { encoder, hardware: isHardwareEncoder(encoder) } })
    try {
      return await attempt({ kind: encoder })
    } catch (error) {
      const ffmpegFailed = error instanceof ProcessError && error.command === this.deps.binaries.ffmpeg && !error.aborted
      if (!isHardwareEncoder(encoder) || !ffmpegFailed || hooks.signal?.aborted) throw error
      const reason = error.stderrTail.at(-1) ?? error.message
      this.log.warn('jobs', `El codificador ${encoderSpec(encoder).label} falló (${reason}); se reintenta con libx264`, {
        ...ref,
        context: { encoder, exitCode: error.code, reason, stderrTail: error.stderrTail }
      })
      hooks.onLog?.(`codificador ${encoderSpec(encoder).label} falló: ${reason}. Reintentando por software (libx264)`)
      return attempt({ kind: SOFTWARE_ENCODER })
    }
  }

  private finish(jobId: string, status: 'done' | 'error' | 'cancelled', message: string | null): void {
    const { repos, events } = this.deps
    const job = repos.jobs.update(jobId, {
      status,
      error: message,
      ...(status === 'done' ? { progress: 100 } : {}),
      current_step: null,
      finished_at: new Date().toISOString()
    })
    if (!job) return
    events.emit({ type: 'job.updated', job })

    // A failed incremental job leaves the published title intact; a failed initial or
    // full reprocess has nothing usable to show
    const publishedIntact = job.tipo === 'agregar_calidad' || job.tipo === 'agregar_pista'
    const title =
      status === 'done'
        ? repos.titles.get(job.title_id)
        : publishedIntact && repos.renditions.listByTitle(job.title_id).some((r) => r.status === 'done')
          ? repos.titles.update(job.title_id, { status: 'done', error: message })
          : repos.titles.update(job.title_id, { status: 'error', error: message })
    if (title) events.emit({ type: 'title.updated', title })
  }
}

// One readable line for the failure message; the full detail travels in the context
function describeFailure(error: unknown, message: string): string {
  if (error instanceof ProcessError) {
    const last = error.stderrTail.at(-1)
    return `${basename(error.command)} terminó con código ${error.code}${last ? `: ${last}` : ''}`
  }
  return message.split('\n')[0]!
}
