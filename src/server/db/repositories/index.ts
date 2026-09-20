import type { DatabaseSync } from 'node:sqlite'
import { createSettingsRepository, type SettingsRepository } from './settings'
import { createTitlesRepository, type TitlesRepository } from './titles'
import { createRenditionsRepository, type RenditionsRepository } from './renditions'
import {
  createAudioTracksRepository,
  createSubtitleTracksRepository,
  type AudioTracksRepository,
  type SubtitleTracksRepository
} from './tracks'
import { createJobsRepository, type JobsRepository } from './jobs'
import { createLogsRepository, type LogsRepository } from './logs'

export interface Repositories {
  settings: SettingsRepository
  titles: TitlesRepository
  renditions: RenditionsRepository
  audioTracks: AudioTracksRepository
  subtitleTracks: SubtitleTracksRepository
  jobs: JobsRepository
  logs: LogsRepository
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    settings: createSettingsRepository(db),
    titles: createTitlesRepository(db),
    renditions: createRenditionsRepository(db),
    audioTracks: createAudioTracksRepository(db),
    subtitleTracks: createSubtitleTracksRepository(db),
    jobs: createJobsRepository(db),
    logs: createLogsRepository(db)
  }
}
