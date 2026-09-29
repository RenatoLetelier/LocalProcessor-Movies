import { aacChannelConfiguration, parseHexdump } from './aac'
import { capture } from './exec'
import type { Binaries, Fraction, HdrTransfer, SourceAudio, SourceHdr, SourceInfo, SourceSubtitle, SourceVideo } from './types'

const IMAGE_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])
const HDR_TRANSFERS: Record<string, HdrTransfer> = { smpte2084: 'pq', 'arib-std-b67': 'hlg' }
// Assumed when a source carries no static metadata; ffmpeg would otherwise assume
// the 10 000-nit PQ ceiling and tone-map everything far too dark
export const DEFAULT_HDR_PEAK_NITS = 1000

export class ProbeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProbeError'
  }
}

export interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  sample_aspect_ratio?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  bit_rate?: string
  pix_fmt?: string
  channels?: number
  channel_layout?: string
  sample_rate?: string
  duration?: string
  color_transfer?: string
  color_primaries?: string
  color_space?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
  side_data_list?: FfprobeSideData[]
  // Hexdump, only with -show_data
  extradata?: string
}

export interface FfprobeSideData {
  side_data_type?: string
  // DOVI configuration record
  dv_profile?: number
  // Mastering display metadata (fraction string, cd/m²) and content light level (integers, cd/m²)
  max_luminance?: string
  max_content?: number
}

export interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string }
}

export interface FfprobeFramesOutput {
  frames?: { side_data_list?: FfprobeSideData[] }[]
}

export async function probeSource(binaries: Binaries, path: string, signal?: AbortSignal): Promise<SourceInfo> {
  const info = parseProbeOutput(await runProbe(binaries, path, signal), path)
  // HDR static metadata travels with the frames, not the stream: decode the first one
  if (info.video.hdr) info.video.hdr.peakNits = parseHdrPeak(await runFrameProbe(binaries, path, info.video.index, signal))
  await readAacChannelConfigs(binaries, path, info.audio, signal)
  return info
}

// Audio dubs and subtitle files have no video: only their tracks matter
export interface TrackFileInfo {
  path: string
  audio: SourceAudio[]
  subtitles: SourceSubtitle[]
}

export async function probeTrackFile(binaries: Binaries, path: string, signal?: AbortSignal): Promise<TrackFileInfo> {
  const output = await runProbe(binaries, path, signal)
  const streams = output.streams ?? []
  const authoredDefault = hasAuthoredSubtitleDefault(output.format?.format_name)
  const audio = streams.filter((s) => s.codec_type === 'audio').map(parseAudio)
  await readAacChannelConfigs(binaries, path, audio, signal)
  return {
    path,
    audio,
    subtitles: streams.filter((s) => s.codec_type === 'subtitle').map((s) => parseSubtitle(s, authoredDefault))
  }
}

// Whether a source AAC can be copied depends on its channelConfiguration, which only
// the extradata carries. A second run limited to the audio streams: -show_data on the
// main one would also hexdump the attachments of an MKV (a 1 MB font is 4 MB of text).
async function readAacChannelConfigs(binaries: Binaries, path: string, audio: SourceAudio[], signal?: AbortSignal): Promise<void> {
  if (!audio.some((a) => a.codec === 'aac')) return
  const json = await capture(
    binaries.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-select_streams', 'a', '-show_entries', 'stream=index,codec_name,extradata', '-show_data', path],
    { signal }
  )
  for (const stream of (JSON.parse(json) as FfprobeOutput).streams ?? []) {
    if (stream.codec_name !== 'aac' || !stream.extradata) continue
    const track = audio.find((a) => a.index === stream.index)
    if (track) track.aacChannelConfig = aacChannelConfiguration(parseHexdump(stream.extradata))
  }
}

async function runProbe(binaries: Binaries, path: string, signal?: AbortSignal): Promise<FfprobeOutput> {
  const json = await capture(
    binaries.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { signal }
  )
  return JSON.parse(json) as FfprobeOutput
}

async function runFrameProbe(binaries: Binaries, path: string, streamIndex: number, signal?: AbortSignal): Promise<FfprobeFramesOutput> {
  const json = await capture(
    binaries.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-select_streams', String(streamIndex), '-read_intervals', '%+#1', '-show_entries', 'frame=side_data_list', '-show_frames', path],
    { signal }
  )
  return JSON.parse(json) as FfprobeFramesOutput
}

export function parseProbeOutput(output: FfprobeOutput, path: string): SourceInfo {
  const streams = output.streams ?? []
  const format = output.format ?? {}

  // Cover art in MKV/MP4 is exposed as a video stream flagged attached_pic
  const videoStream = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  if (!videoStream) throw new ProbeError('El archivo no contiene una pista de video')

  // The container duration spans every stream (a late subtitle cue makes it longer
  // than the picture), so the video stream's own duration wins when it is known
  const durationSeconds =
    toNumber(videoStream.duration) ?? parseTimecode(videoStream.tags?.DURATION) ?? toNumber(format.duration)
  if (!durationSeconds || durationSeconds <= 0) throw new ProbeError('No se pudo determinar la duración del archivo')

  const audio = streams.filter((s) => s.codec_type === 'audio').map(parseAudio)
  const authoredDefault = hasAuthoredSubtitleDefault(format.format_name)
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle').map((s) => parseSubtitle(s, authoredDefault))
  const containerBitrate = toInt(format.bit_rate)
  const sizeBytes = toInt(format.size) ?? 0

  return {
    path,
    sizeBytes,
    durationSeconds,
    containerBitrate,
    video: parseVideo(videoStream, { containerBitrate, sizeBytes, durationSeconds, audio }),
    audio,
    subtitles
  }
}

interface BitrateContext {
  containerBitrate: number | null
  sizeBytes: number
  durationSeconds: number
  audio: SourceAudio[]
}

function parseVideo(stream: FfprobeStream, ctx: BitrateContext): SourceVideo {
  const width = stream.width ?? 0
  const height = stream.height ?? 0
  if (width <= 0 || height <= 0) throw new ProbeError('La pista de video no informa resolución')

  const sar = parseFraction(stream.sample_aspect_ratio) ?? { num: 1, den: 1 }
  const displayWidth = sar.num > 0 && sar.den > 0 ? toEven(Math.round((width * sar.num) / sar.den)) : width

  const declared = toInt(stream.bit_rate) ?? toInt(stream.tags?.BPS) ?? toInt(stream.tags?.['BPS-eng'])
  const estimated = declared ?? estimateVideoBitrate(ctx)

  return {
    index: stream.index,
    codec: stream.codec_name ?? 'unknown',
    width,
    height,
    displayWidth,
    displayHeight: height,
    fps: pickFrameRate(stream),
    bitrate: estimated,
    bitrateEstimated: declared === null,
    pixelFormat: stream.pix_fmt ?? null,
    hdr: parseHdr(stream)
  }
}

// HDR is signalled by the transfer function (PQ or HLG); primaries and matrix
// default to BT.2020 when the stream does not say
function parseHdr(stream: FfprobeStream): SourceHdr | null {
  const colorTransfer = stream.color_transfer ?? ''
  const transfer = HDR_TRANSFERS[colorTransfer]
  if (!transfer) return null
  const dolby = stream.side_data_list?.find((s) => s.side_data_type === 'DOVI configuration record')
  return {
    transfer,
    colorTransfer,
    colorPrimaries: signalled(stream.color_primaries) ?? 'bt2020',
    colorSpace: signalled(stream.color_space) ?? 'bt2020nc',
    peakNits: DEFAULT_HDR_PEAK_NITS,
    dolbyVisionProfile: typeof dolby?.dv_profile === 'number' ? dolby.dv_profile : null
  }
}

// zscale aborts with "no path between colorspaces" on an input declared unknown,
// and losing an hours-long job to a missing tag is worse than assuming BT.2020
function signalled(value: string | undefined): string | undefined {
  return value && !['unknown', 'unspecified', 'reserved'].includes(value) ? value : undefined
}

// MaxCLL is the brightest pixel actually in the content; the mastering display
// peak is the ceiling it was graded on. Either beats the default.
export function parseHdrPeak(output: FfprobeFramesOutput): number {
  const sideData = output.frames?.[0]?.side_data_list ?? []
  const light = sideData.find((s) => s.side_data_type === 'Content light level metadata')
  if (typeof light?.max_content === 'number' && light.max_content > 0) return light.max_content
  const mastering = sideData.find((s) => s.side_data_type === 'Mastering display metadata')
  const peak = parseFraction(mastering?.max_luminance)
  if (peak && peak.den > 0 && peak.num > 0) return Math.round(peak.num / peak.den)
  return DEFAULT_HDR_PEAK_NITS
}

// MKV rarely carries per-stream bitrates: fall back to container bitrate minus the audio we know about
function estimateVideoBitrate(ctx: BitrateContext): number | null {
  const total = ctx.containerBitrate ?? (ctx.sizeBytes > 0 ? Math.round((ctx.sizeBytes * 8) / ctx.durationSeconds) : null)
  if (total === null) return null
  const audioTotal = ctx.audio.reduce((sum, a) => sum + (a.bitrate ?? 0), 0)
  return Math.max(total - audioTotal, Math.round(total * 0.5))
}

function pickFrameRate(stream: FfprobeStream): Fraction {
  const real = parseFraction(stream.r_frame_rate)
  const average = parseFraction(stream.avg_frame_rate)
  const valid = (f: Fraction | null): f is Fraction => !!f && f.num > 0 && f.den > 0
  const value = (f: Fraction): number => f.num / f.den

  // r_frame_rate is the timebase-derived rate and can be absurd for VFR sources
  if (valid(real) && value(real) <= 120 && (!valid(average) || value(real) <= value(average) * 1.5)) return real
  if (valid(average)) return average
  if (valid(real)) return real
  throw new ProbeError('La pista de video no informa frame rate')
}

function parseAudio(stream: FfprobeStream): SourceAudio {
  return {
    index: stream.index,
    codec: stream.codec_name ?? 'unknown',
    channels: stream.channels ?? 2,
    channelLayout: stream.channel_layout ?? null,
    sampleRate: toInt(stream.sample_rate),
    bitrate: toInt(stream.bit_rate) ?? toInt(stream.tags?.BPS) ?? toInt(stream.tags?.['BPS-eng']),
    language: normalizeTag(stream.tags?.language),
    title: normalizeTag(stream.tags?.title),
    isDefault: stream.disposition?.default === 1,
    aacChannelConfig: null
  }
}

// In MP4/MOV ffprobe reports the track "enabled" bit as disposition.default, and muxers set
// it on the first track of each type regardless of intent, so it would turn subtitles on for
// nearly every MP4. Only Matroska (and the like) carries a default flag the author chose.
function hasAuthoredSubtitleDefault(formatName: string | undefined): boolean {
  return !(formatName ?? '').split(',').includes('mp4')
}

function parseSubtitle(stream: FfprobeStream, authoredDefault: boolean): SourceSubtitle {
  const codec = stream.codec_name ?? 'unknown'
  return {
    index: stream.index,
    codec,
    language: normalizeTag(stream.tags?.language),
    title: normalizeTag(stream.tags?.title),
    isForced: stream.disposition?.forced === 1,
    isDefault: authoredDefault && stream.disposition?.default === 1,
    isImage: IMAGE_SUBTITLE_CODECS.has(codec)
  }
}

export function parseFraction(text: string | undefined): Fraction | null {
  if (!text) return null
  const [num, den = '1'] = text.split(/[/:]/)
  const n = Number(num)
  const d = Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d)) return null
  return { num: n, den: d }
}

// Matroska DURATION tags look like 01:52:03.456000000
export function parseTimecode(text: string | undefined): number | null {
  const match = text?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function normalizeTag(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed !== 'und' ? trimmed : null
}

function toNumber(value: string | undefined): number | null {
  const n = Number(value)
  return value !== undefined && Number.isFinite(n) ? n : null
}

function toInt(value: string | undefined): number | null {
  const n = toNumber(value)
  return n === null ? null : Math.round(n)
}

export function toEven(n: number): number {
  return n % 2 === 0 ? n : n + 1
}
