import type { DatabaseSync } from 'node:sqlite'
import type { Binaries } from '@pipeline/types'
import type { HardwareInfo } from '@pipeline/hardware'
import type { Repositories } from './db/repositories'
import type { Prober } from './jobs/enqueue'
import type { ReprocessDeps } from './jobs/reprocess'
import type { ServerEvents } from './jobs/events'
import type { JobRunner } from './jobs/runner'
import type { AppLogger } from './logging/logger'
import type { JobOutputStore } from './logging/job-output'

// Everything the routes need, built once by the host (Electron main or tests)
export interface ServerContext {
  db: DatabaseSync
  repos: Repositories
  events: ServerEvents
  runner: JobRunner
  // Action log (logs table + app.log) and the per-job ffmpeg output files
  log: AppLogger
  jobOutput?: JobOutputStore
  binaries: Binaries
  // Encoders detected at startup; null when detection has not run (tests)
  hardware?: HardwareInfo | null
  probe?: Prober
  probeTracks?: ReprocessDeps['probeTracks']
  checkDiskSpace?: boolean
}
