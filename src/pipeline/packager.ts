import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Standard } from '@shared/config'
import { run } from './exec'
import {
  DASH_MANIFEST,
  INIT_SEGMENT,
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  SEGMENT_TEMPLATE,
  SUBTITLE_SEGMENT_TEMPLATE,
  SUBTITLE_GROUP_ID,
  audioDir,
  audioGroupId,
  encodedAudioFile,
  encodedSubtitleFile,
  encodedVideoFile,
  renditionDir,
  subtitleDir
} from './layout'
import { UNDETERMINED } from './lang'
import type { Binaries, EncodePlan } from './types'

// Folder names inside the job work dir; Shaka runs with the work dir as cwd so
// no absolute path (which may contain "," or "=") ends up in a stream descriptor.
export const ENC_DIR = 'enc'
export const PKG_DIR = 'pkg'

const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/

// Shaka stops the whole run on a language it cannot map to ISO 639-2, "und" included
// ("Unknown/invalid language specified: und"). An untagged track, or one whose tag is not
// a language code, is packaged without one: labelMaster and labelMpd still write the
// language from metadata.json into both manifests.
export function packagerLanguage(language: string): string | undefined {
  return language !== UNDETERMINED && LANGUAGE_TAG.test(language) ? language : undefined
}

const languageField = (language: string): Record<string, string> => {
  const tag = packagerLanguage(language)
  return tag ? { language: tag } : {}
}

export interface PackagerOptions {
  // Incremental runs add streams to a published title whose defaults are already set
  markDefaults?: boolean
}

export function buildPackagerArgs(plan: EncodePlan, standards: Standard[], options: PackagerOptions = {}): string[] {
  const args: string[] = []

  for (const rendition of plan.renditions) {
    const dir = renditionDir(rendition.label)
    args.push(
      descriptor({
        in: `${ENC_DIR}/${encodedVideoFile(rendition.label)}`,
        stream: 'video',
        init_segment: `${PKG_DIR}/${dir}/${INIT_SEGMENT}`,
        segment_template: `${PKG_DIR}/${dir}/${SEGMENT_TEMPLATE}`,
        playlist_name: `${dir}/${MEDIA_PLAYLIST}`
      })
    )
  }

  for (const audio of plan.audio) {
    const dir = audioDir(audio)
    args.push(
      descriptor({
        in: `${ENC_DIR}/${encodedAudioFile(audio)}`,
        stream: 'audio',
        init_segment: `${PKG_DIR}/${dir}/${INIT_SEGMENT}`,
        segment_template: `${PKG_DIR}/${dir}/${SEGMENT_TEMPLATE}`,
        playlist_name: `${dir}/${MEDIA_PLAYLIST}`,
        hls_group_id: audioGroupId(audio),
        hls_name: audio.name,
        dash_label: audio.name,
        ...languageField(audio.language)
      })
    )
  }

  // Raw WebVTT segments: what HLS requires, and what dash.js / Shaka Player / ExoPlayer read as text/vtt.
  // hls_name feeds EXT-X-MEDIA NAME, dash_label the AdaptationSet <Label> (undocumented in --help, works since v2.6)
  for (const subtitle of plan.subtitles) {
    const dir = subtitleDir(subtitle)
    args.push(
      descriptor({
        in: `${ENC_DIR}/${encodedSubtitleFile(subtitle.sourceIndex)}`,
        stream: 'text',
        segment_template: `${PKG_DIR}/${dir}/${SUBTITLE_SEGMENT_TEMPLATE}`,
        playlist_name: `${dir}/${MEDIA_PLAYLIST}`,
        hls_group_id: SUBTITLE_GROUP_ID,
        hls_name: subtitle.name,
        dash_label: subtitle.name,
        ...languageField(subtitle.language),
        ...(subtitle.forced ? { forced_subtitle: '1' } : {})
      })
    )
  }

  args.push('--segment_duration', plan.actualSegmentSeconds.toFixed(6))
  if (options.markDefaults !== false) {
    // Marks DEFAULT=YES (HLS) / Role main (DASH) on the first track of this language
    const defaultAudio = plan.audio.find((a) => a.isDefault) ?? plan.audio[0]
    const defaultAudioLanguage = defaultAudio && packagerLanguage(defaultAudio.language)
    if (defaultAudioLanguage) args.push('--default_language', defaultAudioLanguage)
    // Subtitles stay off unless the source flags one as default: --default_language
    // would otherwise also mark the same-language subtitle DEFAULT=YES ("zxx" = no language)
    const defaultSubtitle = plan.subtitles.find((s) => s.isDefault && !s.forced)
    if (plan.subtitles.length > 0) {
      args.push('--default_text_language', (defaultSubtitle && packagerLanguage(defaultSubtitle.language)) ?? 'zxx')
    }
  }
  if (standards.includes('hls')) {
    args.push('--hls_master_playlist_output', `${PKG_DIR}/${MASTER_PLAYLIST}`, '--hls_playlist_type', 'VOD')
  }
  if (standards.includes('dash')) {
    args.push('--mpd_output', `${PKG_DIR}/${DASH_MANIFEST}`, '--generate_static_live_mpd')
  }

  return args
}

// Stream descriptors are "key=value" pairs separated by commas, with no escaping
function descriptor(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value.replace(/[,=]/g, ' ')}`)
    .join(',')
}

export async function runPackager(
  binaries: Binaries,
  args: string[],
  workDir: string,
  expectedSegments: number,
  hooks: { onProgress?: (percent: number) => void; onLog?: (line: string) => void; signal?: AbortSignal }
): Promise<void> {
  // Shaka reports nothing usable on stdout: progress is inferred from segments written so far
  const pkgDir = join(workDir, PKG_DIR)
  const poll = setInterval(() => {
    void countSegments(pkgDir).then((count) => hooks.onProgress?.(Math.min(99, (count / expectedSegments) * 100)))
  }, 500)

  try {
    await run(binaries.packager, args, { cwd: workDir, signal: hooks.signal, onStderrLine: hooks.onLog })
  } finally {
    clearInterval(poll)
  }
}

async function countSegments(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { recursive: true })
    return entries.filter((name) => name.endsWith('.m4s') || name.endsWith('.vtt')).length
  } catch {
    return 0
  }
}
