import type { AppConfig } from './config'
import type { AudioTrack, Job, LogCategory, LogEntry, LogLevel, Rendition, SubtitleTrack, Title } from './model'

export interface HealthResponse {
  status: 'ok'
  app: string
  version: string
  uptimeSeconds: number
}

export interface ApiError {
  statusCode: number
  error: string
  message: string
}

export interface FolderEntry {
  name: string
  kind: 'dir' | 'file' | 'segments'
  sizeBytes: number
  fileCount: number
  children?: FolderEntry[]
}

export interface TitleFilesResponse {
  root: string
  exists: boolean
  totalBytes: number
  fileCount: number
  entries: FolderEntry[]
}

export interface TitleDetail extends Title {
  renditions: Rendition[]
  audio_tracks: AudioTrack[]
  subtitle_tracks: SubtitleTrack[]
  jobs: Job[]
}

export interface CreateTitleResponse {
  title: Title
  job: Job
}

// Filters of GET /logs; `level` is the minimum level, `before` pages towards the past
export interface LogsQuery {
  level?: LogLevel
  category?: LogCategory
  jobId?: string
  titleId?: string
  q?: string
  before?: number
  limit?: number
}

// Result of scanning the output folder for titles published earlier
export interface ImportSummary {
  imported: Title[]
  relinked: Title[]
  skipped: { folder: string; reason: string }[]
}

export type ServerEvent =
  | { type: 'snapshot'; jobs: Job[] }
  | { type: 'job.progress'; job: Job }
  | { type: 'job.updated'; job: Job }
  | { type: 'title.updated'; title: Title }
  | { type: 'title.deleted'; titleId: string }
  | { type: 'job.log'; jobId: string; line: string }
  | { type: 'config.updated'; config: AppConfig }
  | { type: 'log.entry'; entry: LogEntry }

export interface ReprocessFile {
  path: string
  kind: 'audio' | 'subtitle'
  language?: string
  name?: string
  forced?: boolean
}

export interface ReprocessRequest {
  tipo: 'agregar_calidad' | 'agregar_pista' | 'reprocesar_completo'
  qualities?: string[]
  audio?: number[]
  subtitles?: number[]
  files?: ReprocessFile[]
  standards?: ('hls' | 'dash')[]
  segmentDurationSeconds?: number
}

export interface SystemInfo {
  platform: string
  cpuThreads: number
  encoders: { kind: string; label: string; hardware: boolean; available: boolean; error?: string }[]
  selectedEncoder: string
  concurrency: number
  // Bound address of the API; 0.0.0.0 while LAN access is on
  listening: { host: string; port: number } | null
  lanAddresses: string[]
}
