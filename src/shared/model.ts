// Row shapes as stored in SQLite and returned by the API. Column names follow
// the ER diagram of docs/documentacion-tecnica.md verbatim (mixed es/en included).

export type TitleStatus = 'queued' | 'processing' | 'done' | 'error'
export type ArtifactStatus = 'pending' | 'processing' | 'done' | 'error'
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
export type JobTipo = 'inicial' | 'agregar_calidad' | 'agregar_pista' | 'reprocesar_completo'

export interface Title {
  id: string
  name: string
  // null for titles imported from the output folder until a source file is linked
  source_path: string | null
  source_hash: string | null
  source_width: number | null
  source_height: number | null
  source_video_bitrate: number | null
  source_fps: number | null
  source_video_codec: string | null
  // 'pq' | 'hlg' for HDR sources, which are tone-mapped to SDR on output
  source_hdr: string | null
  duration_seconds: number | null
  output_folder: string
  // True when the source file was uploaded through the API and is ours to delete
  source_managed: boolean
  status: TitleStatus
  error: string | null
  created_at: string
  updated_at: string
}

export interface Rendition {
  id: string
  title_id: string
  label: string
  width: number
  height: number
  bitrate: number
  video_codec: string
  status: ArtifactStatus
}

export interface AudioTrack {
  id: string
  title_id: string
  // Stream index in the source file; negative for tracks added from external files
  source_index: number
  source_path: string | null
  language: string | null
  title: string | null
  codec_origen: string
  codec_salida: string | null
  channels: number | null
  status: ArtifactStatus
}

export interface SubtitleTrack {
  id: string
  title_id: string
  source_index: number
  source_path: string | null
  language: string | null
  title: string | null
  formato_origen: string
  formato_salida: string | null
  requiere_ocr: boolean
  status: ArtifactStatus
}

export interface Job {
  id: string
  title_id: string
  tipo: JobTipo
  status: JobStatus
  config_json: string
  progress: number
  current_step: string | null
  error: string | null
  attempts: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}

// Action log: every state change, job step and failure, kept in SQLite for the Logs section
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogCategory = 'app' | 'api' | 'config' | 'titles' | 'jobs' | 'pipeline'
export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']
export const LOG_CATEGORIES: LogCategory[] = ['app', 'api', 'config', 'titles', 'jobs', 'pipeline']

export interface LogEntry {
  id: number
  ts: string
  level: LogLevel
  category: LogCategory
  message: string
  job_id: string | null
  title_id: string | null
  // Structured detail (paths, sizes, commands, the last ffmpeg lines on a failure)
  context: Record<string, unknown> | null
}
