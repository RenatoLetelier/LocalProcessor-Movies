import type { Rung, Standard } from '@shared/config'
import type { TrackOverrides } from '@shared/model'
import type { EncoderKind } from './encoders'

export interface Binaries {
  ffmpeg: string
  ffprobe: string
  packager: string
}

export interface Fraction {
  num: number
  den: number
}

export interface SourceVideo {
  index: number
  codec: string
  // Coded dimensions and the square-pixel dimensions a player would display
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  fps: Fraction
  bitrate: number | null
  bitrateEstimated: boolean
  pixelFormat: string | null
  // null for SDR sources; HDR ones are tone-mapped to SDR by the encode
  hdr: SourceHdr | null
}

export type HdrTransfer = 'pq' | 'hlg'

export interface SourceHdr {
  transfer: HdrTransfer
  // ffprobe names of the colour signalling, handed to zscale verbatim
  colorTransfer: string
  colorPrimaries: string
  colorSpace: string
  // Brightest signal in nits (MaxCLL, else mastering display peak, else DEFAULT_HDR_PEAK_NITS)
  peakNits: number
  // Dolby Vision profile when present; profile 5 has no HDR10-compatible base layer
  dolbyVisionProfile: number | null
}

export interface SourceAudio {
  index: number
  codec: string
  channels: number
  channelLayout: string | null
  sampleRate: number | null
  bitrate: number | null
  language: string | null
  title: string | null
  isDefault: boolean
  // channelConfiguration of an AAC AudioSpecificConfig (0 = layout described by a PCE);
  // null for other codecs and for AAC without extradata (ADTS)
  aacChannelConfig: number | null
}

export interface SourceSubtitle {
  index: number
  codec: string
  language: string | null
  title: string | null
  isForced: boolean
  isDefault: boolean
  isImage: boolean
}

export interface SourceInfo {
  path: string
  sizeBytes: number
  durationSeconds: number
  containerBitrate: number | null
  video: SourceVideo
  audio: SourceAudio[]
  subtitles: SourceSubtitle[]
}

// Where ffmpeg reads a track from: the title source (no path) or an external file
export interface TrackInput {
  path?: string
  streamIndex: number
}

// A track added from a separate file (a downloaded .srt, an audio dub…). It gets a
// negative sourceIndex so it never collides with the title's own stream indexes.
export interface ExternalTrack {
  kind: 'audio' | 'subtitle'
  sourceIndex: number
  path: string
  language?: string | null
  name?: string | null
  forced?: boolean
}

export interface RenditionPlan {
  label: string
  width: number
  height: number
  maxBitrateKbps: number
  gopFrames: number
  // Set when no configured rung applied and the source is served at its own size
  nativeFallback?: true
  // The source video stream as is, not re-encoded: zero loss and seconds of work
  copy?: true
}

export type AudioAction = 'copy' | 'transcode'

export interface AudioPlan {
  // Track identity (DB source_index, folder name); negative for external tracks
  sourceIndex: number
  input: TrackInput
  action: AudioAction
  sourceCodec: string
  outputCodec: string
  channels: number
  bitrateKbps: number | null
  language: string
  name: string
  title: string | null
  isDefault: boolean
}

export interface SubtitlePlan {
  sourceIndex: number
  input: TrackInput
  sourceCodec: string
  language: string
  name: string
  title: string | null
  forced: boolean
  isDefault: boolean
}

export interface SkippedItem {
  kind: 'rendition' | 'audio' | 'subtitle'
  id: string
  reason: string
}

export interface EncodePlan {
  fps: Fraction
  segmentDurationSeconds: number
  // Exact segment length once the GOP is snapped to whole frames
  actualSegmentSeconds: number
  renditions: RenditionPlan[]
  audio: AudioPlan[]
  // Text subtitles converted to WebVTT; image subtitles end up in `skipped`
  subtitles: SubtitlePlan[]
  skipped: SkippedItem[]
  // 'source': encoded renditions put their keyframes where the source has them, so they
  // cut on the same boundaries as a copied rendition; otherwise a fixed GOP per segment
  keyframes?: 'source'
}

export interface PlanOptions {
  rungs: Record<string, Rung>
  qualities: string[]
  segmentDurationSeconds: number
  // Restrict which source tracks are planned (undefined = all of them)
  audioIndexes?: number[]
  subtitleIndexes?: number[]
  // Incremental jobs must not invent a native rung when the requested one does not apply
  allowNativeFallback?: boolean
  // Copy the source video when browsers already decode it and it fits under this bitrate
  copyVideo?: { maxBitrateKbps: number }
  // Title that already publishes a copied rendition: new rungs must align to its keyframes
  alignToSourceKeyframes?: boolean
}

export type PipelineStep = 'probe' | 'plan' | 'encode' | 'package' | 'publish'

export interface ProgressEvent {
  step: PipelineStep
  // 0..100 within the step; undefined when the step cannot report progress
  stepPercent?: number
  // 0..100 across the whole pipeline
  percent: number
  message?: string
}

export interface PipelineInput {
  titleId: string
  name: string
  sourcePath: string
  outputRoot: string
  standards: Standard[]
  plan: PlanOptions
  externalTracks?: ExternalTrack[]
  // Full reprocess of a published title: the new package replaces the old folder
  replaceExisting?: boolean
  videoEncoder?: VideoEncoderOptions
  // Names, languages and default tracks decided outside, over what the source says
  trackOverrides?: TrackOverrides | null
}

export interface VideoEncoderOptions {
  // Which H.264 encoder drives the run (default: software libx264)
  kind?: EncoderKind
  // libx264 preset and CRF; hardware encoders derive their own quality knobs from crf
  preset?: string
  crf?: number
}

// Structured account of what a step decided or produced, for the action log
export interface PipelineLogEvent {
  level: 'debug' | 'info' | 'warn'
  message: string
  context?: Record<string, unknown>
}
export interface PipelineHooks {
  onProgress?: (event: ProgressEvent) => void
  // Raw ffmpeg / packager output and commands, line by line
  onLog?: (line: string) => void
  onEvent?: (event: PipelineLogEvent) => void
  signal?: AbortSignal
}

export interface PipelineResult {
  titleId: string
  outputFolder: string
  source: SourceInfo
  plan: EncodePlan
  metadata: TitleMetadata
}

// What an incremental job adds to an already published title
export interface IncrementalInput {
  titleId: string
  name: string
  sourcePath: string
  outputRoot: string
  rungs: Record<string, Rung>
  qualities: string[]
  audioIndexes: number[]
  subtitleIndexes: number[]
  externalTracks: ExternalTrack[]
  videoEncoder?: VideoEncoderOptions
  trackOverrides?: TrackOverrides | null
}

export interface TitleMetadata {
  schemaVersion: 1
  titleId: string
  name: string
  durationSeconds: number
  standards: Standard[]
  manifests: Partial<Record<Standard, string>>
  segmentDurationSeconds: number
  // What the source was graded in and what the renditions carry (always SDR for now)
  dynamicRange: { source: 'sdr' | HdrTransfer; output: 'sdr' }
  // Where the title came from, so a library can be rebuilt from the folder alone
  source: MetadataSource
  renditions: MetadataRendition[]
  audioTracks: MetadataAudioTrack[]
  subtitleTracks: MetadataSubtitleTrack[]
  updatedAt: string
}

export interface MetadataSource {
  path: string
  sizeBytes: number
  width: number
  height: number
  fps: number
  codec: string
  bitrate: number | null
}

export interface MetadataRendition {
  label: string
  width: number
  height: number
  // Measured average in bps; maxBitrate is the encoder ceiling
  bitrate: number
  maxBitrate: number
  codec: string
  path: string
  // The source video stream packaged as is, not re-encoded
  copied?: boolean
}

export interface MetadataAudioTrack {
  id: string
  language: string
  name: string
  codec: string
  channels: number
  path: string
  // Stream index in the source (negative for external files) and its codec there
  sourceIndex: number
  sourceCodec: string
  // The track players pick without being asked: DEFAULT=YES in HLS, Role main in DASH
  default?: boolean
  // What the source said, kept while an override (a name from a catalog) replaces it
  original?: TrackLabel
}

export interface MetadataSubtitleTrack {
  id: string
  language: string
  name: string
  format: string
  forced: boolean
  path: string
  sourceIndex: number
  sourceFormat: string
  default?: boolean
  original?: TrackLabel
}

// How a published track is presented to players. Rewritten in place over the
// manifests and metadata.json, without touching a single segment.
export interface TrackLabel {
  name: string
  language: string
  default: boolean
  // Subtitles only
  forced?: boolean
}
