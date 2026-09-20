import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { audioTrackId, subtitleTrackId, trackKey } from './layout'
import type { EncodePlan, PipelineHooks, PipelineLogEvent, SourceInfo } from './types'
import type { EncodeOutputs, SubtitleExtraction } from './ffmpeg'
import type { TrackFileInfo } from './probe'

// Everything a person needs to see in the log to know what the pipeline found,
// decided and produced. Messages are short; the context carries the detail.

export function emit(hooks: PipelineHooks, event: PipelineLogEvent): void {
  hooks.onEvent?.(event)
}

export function sourceEvent(source: SourceInfo): PipelineLogEvent {
  const { video } = source
  const fps = video.fps.num / video.fps.den
  const hdr = video.hdr ? ` HDR (${video.hdr.transfer === 'pq' ? 'HDR10/PQ' : 'HLG'}${video.hdr.dolbyVisionProfile ? `, Dolby Vision perfil ${video.hdr.dolbyVisionProfile}` : ''})` : ''
  const bitrate = video.bitrate ? `, ${mbps(video.bitrate)}${video.bitrateEstimated ? ' (estimado)' : ''}` : ''
  return {
    level: 'info',
    message: `Origen analizado: ${video.displayWidth}×${video.displayHeight} ${video.codec} a ${fps.toFixed(3)} fps${bitrate}${hdr}, ${clock(source.durationSeconds)}, ${source.audio.length} pista(s) de audio, ${source.subtitles.length} subtítulo(s)`,
    context: {
      path: source.path,
      sizeBytes: source.sizeBytes,
      durationSeconds: source.durationSeconds,
      video: {
        codec: video.codec,
        width: video.width,
        height: video.height,
        displayWidth: video.displayWidth,
        displayHeight: video.displayHeight,
        fps: Number(fps.toFixed(3)),
        bitrate: video.bitrate,
        bitrateEstimated: video.bitrateEstimated,
        pixelFormat: video.pixelFormat,
        hdr: video.hdr
      },
      audio: source.audio.map((a) => ({
        index: a.index,
        codec: a.codec,
        channels: a.channels,
        layout: a.channelLayout,
        language: a.language,
        title: a.title,
        default: a.isDefault
      })),
      subtitles: source.subtitles.map((s) => ({
        index: s.index,
        codec: s.codec,
        language: s.language,
        title: s.title,
        forced: s.isForced,
        default: s.isDefault,
        image: s.isImage
      }))
    }
  }
}

export function externalsEvent(infos: Map<string, TrackFileInfo | null>): PipelineLogEvent | null {
  if (infos.size === 0) return null
  const files = [...infos.entries()].map(([path, info]) => ({
    path,
    readable: info !== null,
    audio: info?.audio.map((a) => `${a.codec} ${a.channels}ch ${a.language ?? 'und'}`) ?? [],
    subtitles: info?.subtitles.map((s) => `${s.codec} ${s.language ?? 'und'}`) ?? []
  }))
  const unreadable = files.filter((f) => !f.readable)
  return {
    level: unreadable.length ? 'warn' : 'info',
    message: `Archivos externos analizados: ${files.length}${unreadable.length ? ` (${unreadable.length} ilegible(s): ${unreadable.map((f) => basename(f.path)).join(', ')})` : ''}`,
    context: { files }
  }
}

export function planEvents(plan: EncodePlan): PipelineLogEvent[] {
  const renditions = plan.renditions.map((r) => `${r.label} ${r.width}×${r.height} ≤${r.maxBitrateKbps} kbps${r.nativeFallback ? ' (resolución nativa)' : ''}`)
  const audio = plan.audio.map((a) => `${audioTrackId(a)} ${a.action === 'copy' ? `${a.outputCodec} copiado` : `${a.sourceCodec} → ${a.outputCodec}`} ${a.channels}ch`)
  const subtitles = plan.subtitles.map((s) => `${subtitleTrackId(s)} ${s.sourceCodec}${s.forced ? ' forzado' : ''}`)
  const events: PipelineLogEvent[] = [
    {
      level: 'info',
      message: `Plan: ${plan.renditions.length} calidad(es) [${renditions.join('; ')}], ${plan.audio.length} pista(s) de audio de salida [${audio.join('; ')}], ${plan.subtitles.length} subtítulo(s)${subtitles.length ? ` [${subtitles.join('; ')}]` : ''}; segmentos de ${plan.actualSegmentSeconds.toFixed(3)} s`,
      context: {
        segmentDurationSeconds: plan.segmentDurationSeconds,
        actualSegmentSeconds: plan.actualSegmentSeconds,
        renditions: plan.renditions.map((r) => ({ label: r.label, width: r.width, height: r.height, maxBitrateKbps: r.maxBitrateKbps, gopFrames: r.gopFrames, nativeFallback: r.nativeFallback ?? false })),
        audio: plan.audio.map((a) => ({
          id: audioTrackId(a),
          sourceIndex: a.sourceIndex,
          action: a.action,
          sourceCodec: a.sourceCodec,
          outputCodec: a.outputCodec,
          channels: a.channels,
          bitrateKbps: a.bitrateKbps,
          language: a.language,
          name: a.name,
          external: a.input.path ?? null
        })),
        subtitles: plan.subtitles.map((s) => ({
          id: subtitleTrackId(s),
          sourceIndex: s.sourceIndex,
          sourceCodec: s.sourceCodec,
          language: s.language,
          name: s.name,
          forced: s.forced,
          default: s.isDefault,
          external: s.input.path ?? null
        })),
        audioSummary: audio,
        subtitleSummary: subtitles
      }
    }
  ]
  if (plan.skipped.length > 0) {
    events.push({
      level: 'warn',
      message: `Omitido: ${plan.skipped.map((s) => `${kindLabel(s.kind)} ${s.id} (${s.reason})`).join('; ')}`,
      context: { skipped: plan.skipped }
    })
  }
  return events
}

export function subtitlesEvent(extraction: SubtitleExtraction): PipelineLogEvent[] {
  const events: PipelineLogEvent[] = []
  if (extraction.extracted.length > 0) {
    events.push({
      level: 'info',
      message: `Subtítulos convertidos a WebVTT: ${extraction.extracted.map(subtitleTrackId).join(', ')}`,
      context: { files: extraction.files.map((f) => ({ track: trackKey(f.sourceIndex), file: basename(f.file) })) }
    })
  }
  if (extraction.failed.length > 0) {
    events.push({
      level: 'warn',
      message: `Subtítulos que no se pudieron convertir: ${extraction.failed.map((f) => `${f.id} (${f.reason})`).join('; ')}`,
      context: { failed: extraction.failed }
    })
  }
  return events
}

export function commandEvent(tool: 'ffmpeg' | 'packager', args: string[], extra: Record<string, unknown> = {}): PipelineLogEvent {
  return { level: 'debug', message: `Comando ${tool}: ${tool} ${args.join(' ')}`, context: { tool, args, ...extra } }
}

export async function encodedEvent(outputs: EncodeOutputs): Promise<PipelineLogEvent> {
  const files = await Promise.all(
    [...outputs.video.map((v) => ({ stream: v.label, file: v.file })), ...outputs.audio.map((a) => ({ stream: `audio ${trackKey(a.sourceIndex)} ${a.outputCodec}`, file: a.file }))].map(
      async (o) => ({ ...o, bytes: (await stat(o.file).catch(() => null))?.size ?? null })
    )
  )
  const total = files.reduce((sum, f) => sum + (f.bytes ?? 0), 0)
  return {
    level: 'info',
    message: `Codificación terminada: ${files.length} archivo(s), ${size(total)}`,
    context: { files: files.map((f) => ({ stream: f.stream, file: basename(f.file), bytes: f.bytes })) }
  }
}

export async function publishedEvent(folder: string, detail: Record<string, unknown>): Promise<PipelineLogEvent> {
  const bytes = await folderSize(folder)
  return { level: 'info', message: `Publicado en ${folder} (${size(bytes)})`, context: { outputFolder: folder, bytes, ...detail } }
}

async function folderSize(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await folderSize(path)
    else total += (await stat(path).catch(() => null))?.size ?? 0
  }
  return total
}

const kindLabel = (kind: string): string => (kind === 'rendition' ? 'calidad' : kind === 'audio' ? 'audio' : 'subtítulo')
const mbps = (bps: number): string => `${(bps / 1_000_000).toFixed(1).replace('.', ',')} Mbps`

export function size(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1).replace('.', ',')} ${units[unit]}`
}

export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.round(seconds % 60)
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(s).padStart(2, '0')} s`
}
