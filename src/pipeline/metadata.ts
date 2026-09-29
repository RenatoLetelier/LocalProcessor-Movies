import { rename, stat, writeFile } from 'node:fs/promises'
import type { Standard } from '@shared/config'
import { DASH_MANIFEST, MASTER_PLAYLIST, SUBTITLE_FORMAT, audioDir, audioTrackId, renditionDir, subtitleDir, subtitleTrackId } from './layout'
import type { EncodeOutputs } from './ffmpeg'
import type { EncodePlan, SourceInfo, TitleMetadata } from './types'

export const VIDEO_CODEC_NAME = 'h264'

export interface MetadataInput {
  titleId: string
  name: string
  standards: Standard[]
  source: SourceInfo
  plan: EncodePlan
  outputs: EncodeOutputs
}

export async function buildMetadata(input: MetadataInput): Promise<TitleMetadata> {
  const { plan, source } = input
  const manifests: TitleMetadata['manifests'] = {}
  if (input.standards.includes('hls')) manifests.hls = MASTER_PLAYLIST
  if (input.standards.includes('dash')) manifests.dash = DASH_MANIFEST

  // The pipeline's own choice; labels.ts may still move it when a consumer overrides it
  const defaultAudio = (plan.audio.find((a) => a.isDefault) ?? plan.audio[0])?.sourceIndex
  const defaultSubtitle = plan.subtitles.find((s) => s.isDefault && !s.forced)?.sourceIndex

  const renditions = await Promise.all(
    plan.renditions.map(async (rendition) => {
      const file = input.outputs.video.find((v) => v.label === rendition.label)?.file
      return {
        label: rendition.label,
        width: rendition.width,
        height: rendition.height,
        // Measured average of the encoded stream; the rung ceiling is maxBitrate
        bitrate: file ? await averageBitrate(file, source.durationSeconds) : rendition.maxBitrateKbps * 1000,
        maxBitrate: rendition.maxBitrateKbps * 1000,
        codec: VIDEO_CODEC_NAME,
        path: renditionDir(rendition.label),
        ...(rendition.copy ? { copied: true } : {})
      }
    })
  )

  return {
    schemaVersion: 1,
    titleId: input.titleId,
    name: input.name,
    durationSeconds: source.durationSeconds,
    standards: input.standards,
    manifests,
    segmentDurationSeconds: plan.actualSegmentSeconds,
    dynamicRange: { source: source.video.hdr?.transfer ?? 'sdr', output: 'sdr' },
    source: {
      path: source.path,
      sizeBytes: source.sizeBytes,
      width: source.video.displayWidth,
      height: source.video.displayHeight,
      fps: source.video.fps.num / source.video.fps.den,
      codec: source.video.codec,
      bitrate: source.video.bitrate
    },
    renditions,
    audioTracks: plan.audio.map((audio) => ({
      id: audioTrackId(audio),
      language: audio.language,
      name: audio.name,
      codec: audio.outputCodec,
      channels: audio.channels,
      path: audioDir(audio),
      sourceIndex: audio.sourceIndex,
      sourceCodec: audio.sourceCodec,
      default: audio.sourceIndex === defaultAudio
    })),
    subtitleTracks: plan.subtitles.map((subtitle) => ({
      id: subtitleTrackId(subtitle),
      language: subtitle.language,
      name: subtitle.name,
      format: SUBTITLE_FORMAT,
      forced: subtitle.forced,
      path: subtitleDir(subtitle),
      sourceIndex: subtitle.sourceIndex,
      sourceFormat: subtitle.sourceCodec,
      default: subtitle.sourceIndex === defaultSubtitle
    })),
    updatedAt: new Date().toISOString()
  }
}

async function averageBitrate(file: string, durationSeconds: number): Promise<number> {
  const { size } = await stat(file)
  return Math.round((size * 8) / durationSeconds)
}

// Readers see either the previous file or the new one, never a partial write
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}
