import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SOFTWARE_ENCODER, encoderFilterSuffix, encoderGlobalArgs, encoderInputArgs, videoCodecArgs } from './encoders'
import { run } from './exec'
import { encodedAudioFile, encodedSubtitleFile, encodedVideoFile } from './layout'
import type {
  AudioPlan,
  Binaries,
  EncodePlan,
  RenditionPlan,
  SkippedItem,
  SourceHdr,
  SourceInfo,
  SubtitlePlan,
  TrackInput,
  VideoEncoderOptions
} from './types'

export const DEFAULT_VIDEO_ENCODER: Required<VideoEncoderOptions> = { kind: SOFTWARE_ENCODER, preset: 'medium', crf: 20 }

export interface EncodeOutputs {
  video: { label: string; file: string }[]
  audio: { sourceIndex: number; outputCodec: string; file: string }[]
}

// One ffmpeg invocation decodes the source once and writes every rendition and
// audio track as separate MP4 intermediates for the packager. External track
// files are extra inputs of the same run. A copied rendition comes straight from the
// demuxer, by absolute index so cover art (attached_pic) never gets picked.
export function buildFfmpegArgs(
  source: SourceInfo,
  plan: EncodePlan,
  encDir: string,
  encoder: VideoEncoderOptions = {}
): { args: string[]; outputs: EncodeOutputs } {
  const opts = { ...DEFAULT_VIDEO_ENCODER, ...encoder }
  const inputs = new InputList(source.path)
  for (const audio of plan.audio) inputs.add(audio.input.path)

  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', ...encoderGlobalArgs(opts.kind)]
  inputs.paths.forEach((path, i) => args.push(...(i === 0 ? encoderInputArgs(opts.kind) : []), '-i', path))
  const outputs: EncodeOutputs = { video: [], audio: [] }

  const videoInput = `0:${source.video.index}`
  const encoded = plan.renditions.filter((r) => !r.copy)
  const suffix = encoderFilterSuffix(opts.kind)
  // HDR is mapped to SDR once, before the frames fan out to the renditions, and on
  // frames already reduced to the largest one: the float math per pixel costs twice
  // as much at 4K as at 1080p.
  const top = encoded.reduce<RenditionPlan | undefined>((a, b) => (a && a.width * a.height >= b.width * b.height ? a : b), undefined)
  const toneMap = source.video.hdr && top ? `${scaleTo(top)},${hdrToSdrFilter(source.video.hdr)}` : ''
  if (encoded.length > 1) {
    const chain = encoded.map((r) => `[s_${r.label}]${scaleTo(r)}${suffix}[v_${r.label}]`)
    args.push(
      '-filter_complex',
      `[${videoInput}]${toneMap ? `${toneMap},` : ''}split=${encoded.length}${encoded.map((r) => `[s_${r.label}]`).join('')};${chain.join(';')}`
    )
  }

  for (const rendition of plan.renditions) {
    const file = join(encDir, encodedVideoFile(rendition.label))
    if (rendition.copy) args.push('-map', videoInput, '-c:v', 'copy')
    else if (encoded.length > 1) args.push('-map', `[v_${rendition.label}]`, ...videoCodecArgs(opts.kind, rendition, plan, opts))
    else args.push('-map', videoInput, '-vf', `${toneMap || scaleTo(rendition)}${suffix}`, ...videoCodecArgs(opts.kind, rendition, plan, opts))
    args.push('-an', '-sn', '-dn', '-map_metadata', '-1', '-f', 'mp4', file)
    outputs.video.push({ label: rendition.label, file })
  }

  for (const audio of plan.audio) {
    const file = join(encDir, encodedAudioFile(audio))
    args.push('-map', inputs.map(audio.input), ...audioCodecArgs(audio), '-vn', '-sn', '-dn', '-map_metadata', '-1', '-f', 'mp4', file)
    outputs.audio.push({ sourceIndex: audio.sourceIndex, outputCodec: audio.outputCodec, file })
  }

  return { args, outputs }
}

// Distinct input files of a run, in first-use order; the title source is always input 0
class InputList {
  readonly paths: string[]

  constructor(primary: string) {
    this.paths = [primary]
  }

  add(path: string | undefined): void {
    if (path && !this.paths.includes(path)) this.paths.push(path)
  }

  map(input: TrackInput): string {
    const index = input.path ? this.paths.indexOf(input.path) : 0
    return `${index}:${input.streamIndex}`
  }
}

// setsar=1 turns anamorphic sources into square pixels at the display size
function scaleTo(rendition: RenditionPlan): string {
  return `scale=${rendition.width}:${rendition.height}:flags=bicubic,setsar=1`
}

// Linearise the HDR signal (100 nits = 1.0) and move to BT.709 primaries in the same
// zscale (split in two, with the input declared, zscale aborts), compress the
// highlights above the SDR range and re-encode as BT.709 8-bit video. The signal peak
// comes from the source metadata, in units of the 100-nit reference white the linear
// stage established.
//
// mobius is linear up to 30 nits and compresses gently from there (100 nits land at
// 66 % of SDR white, 200 at 82 %), leaving the top of the range for the highlights;
// hable flattens the whole midrange (100 nits at 31 %) and the picture comes out dark.
//
// zscale tags the frames BT.709, which the encoders write into the stream, so players
// and the packager (VIDEO-RANGE=SDR) see plain SDR; the -color_* output options are
// deliberately not used because ffmpeg 8 turns them into a conversion request. The
// HDR10 static metadata travels as frame side data all the way to the encoder and
// the muxer: without deleting it, the SDR H.264 declares BT.709 and at the same time
// a 1000-nit BT.2020 mastering display (mdcv/clli in the init segment, SEI in the stream).
export function hdrToSdrFilter(hdr: SourceHdr): string {
  const peak = (hdr.peakNits / 100).toFixed(2)
  return [
    `zscale=tin=${hdr.colorTransfer}:pin=${hdr.colorPrimaries}:min=${hdr.colorSpace}:t=linear:npl=100:p=bt709`,
    'format=gbrpf32le',
    `tonemap=tonemap=mobius:desat=0:peak=${peak}`,
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p',
    'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
    'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL'
  ].join(',')
}

function audioCodecArgs(audio: AudioPlan): string[] {
  // An AAC out of a .ts carries ADTS headers the MP4 muxer rejects; the filter strips
  // them and lets everything else through untouched
  if (audio.action === 'copy') return ['-c:a', 'copy', ...(audio.outputCodec === 'aac' ? ['-bsf:a', 'aac_adtstoasc'] : [])]
  return ['-c:a', audio.outputCodec, '-b:a', `${audio.bitrateKbps}k`, '-ac', String(audio.channels)]
}

export interface EncodeProgress {
  outTimeSeconds: number
  percent: number
}

export function parseProgressLine(line: string, durationSeconds: number): EncodeProgress | null {
  const [key, value] = line.split('=', 2)
  if (key !== 'out_time_us' || value === undefined) return null
  const seconds = Number(value) / 1e6
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return { outTimeSeconds: seconds, percent: Math.min(100, (seconds / durationSeconds) * 100) }
}

export async function runFfmpeg(
  binaries: Binaries,
  args: string[],
  durationSeconds: number,
  hooks: { onProgress?: (p: EncodeProgress) => void; onLog?: (line: string) => void; signal?: AbortSignal }
): Promise<void> {
  await run(binaries.ffmpeg, args, {
    signal: hooks.signal,
    onStdoutLine: (line) => {
      const progress = parseProgressLine(line, durationSeconds)
      if (progress) hooks.onProgress?.(progress)
    },
    onStderrLine: hooks.onLog
  })
}

export function buildSubtitleArgs(source: SourceInfo, subtitle: SubtitlePlan, encDir: string): { args: string[]; file: string } {
  const file = join(encDir, encodedSubtitleFile(subtitle.sourceIndex))
  const input = subtitle.input.path ?? source.path
  return {
    args: ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', input, '-map', `0:${subtitle.input.streamIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', file],
    file
  }
}

// Every text track of one file in a single ffmpeg run. The subtitles are interleaved with
// the video along the whole file, so each run reads all of it: one run per track read a
// 19 GB movie with 35 tracks 35 times, 670 GB, before the encode even started.
export function buildSubtitleBatchArgs(input: string, subtitles: SubtitlePlan[], encDir: string): { args: string[]; files: string[] } {
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', input]
  const files = subtitles.map((subtitle) => {
    const file = join(encDir, encodedSubtitleFile(subtitle.sourceIndex))
    args.push('-map', `0:${subtitle.input.streamIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', file)
    return file
  })
  return { args, files }
}

export interface SubtitleExtraction {
  extracted: SubtitlePlan[]
  files: { sourceIndex: number; file: string }[]
  failed: SkippedItem[]
  // Why the single run over a file failed and its tracks were converted one by one
  fallbacks: { input: string; reason: string }[]
}

type SubtitleOutcome = { file: string } | SkippedItem

const firstLine = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0]! : String(error))

function unconverted(subtitle: SubtitlePlan, error: unknown): SkippedItem {
  return { kind: 'subtitle', id: String(subtitle.sourceIndex), reason: `no se pudo convertir a WebVTT: ${firstLine(error)}` }
}

async function checkConverted(subtitle: SubtitlePlan, file: string, onLog?: (line: string) => void): Promise<SubtitleOutcome> {
  const text = await readFile(file, 'utf8')
  const repaired = repairWebVtt(text)
  if (repaired !== text) {
    await writeFile(file, repaired, 'utf8')
    onLog?.(`subtítulo ${subtitle.sourceIndex}: texto con líneas en blanco reunido con su subtítulo`)
  }
  // The packager aborts the whole run on a WebVTT without cues (END_OF_STREAM)
  if (!/-->/.test(repaired)) return { kind: 'subtitle', id: String(subtitle.sourceIndex), reason: 'la pista no contiene ningún subtítulo' }
  return { file }
}

async function extractOne(
  binaries: Binaries,
  source: SourceInfo,
  subtitle: SubtitlePlan,
  encDir: string,
  hooks: { onLog?: (line: string) => void; signal?: AbortSignal }
): Promise<SubtitleOutcome> {
  const { args, file } = buildSubtitleArgs(source, subtitle, encDir)
  hooks.onLog?.(`ffmpeg ${args.join(' ')}`)
  try {
    await run(binaries.ffmpeg, args, { signal: hooks.signal, onStderrLine: hooks.onLog })
    return await checkConverted(subtitle, file, hooks.onLog)
  } catch (error) {
    if (hooks.signal?.aborted) throw error
    return unconverted(subtitle, error)
  }
}

// Text subtitles go before the video encode, all the tracks of a file in one read. A track
// ffmpeg cannot convert is reported as skipped instead of failing the job: when the single
// run fails, its tracks are converted one by one so only the broken one is left out.
// onProgress is 0..100 of the read through the source, the only long one.
export async function extractSubtitles(
  binaries: Binaries,
  source: SourceInfo,
  subtitles: SubtitlePlan[],
  encDir: string,
  hooks: { onLog?: (line: string) => void; onProgress?: (percent: number) => void; signal?: AbortSignal }
): Promise<SubtitleExtraction> {
  const result: SubtitleExtraction = { extracted: [], files: [], failed: [], fallbacks: [] }
  const groups = new Map<string, SubtitlePlan[]>()
  for (const subtitle of subtitles) {
    const input = subtitle.input.path ?? source.path
    groups.set(input, [...(groups.get(input) ?? []), subtitle])
  }

  const outcomes = new Map<SubtitlePlan, SubtitleOutcome>()
  for (const [input, group] of groups) {
    if (group.length > 1) {
      const { args, files } = buildSubtitleBatchArgs(input, group, encDir)
      hooks.onLog?.(`ffmpeg ${args.join(' ')}`)
      try {
        await runFfmpeg(binaries, args, source.durationSeconds, {
          onProgress: input === source.path ? (p) => hooks.onProgress?.(p.percent) : undefined,
          onLog: hooks.onLog,
          signal: hooks.signal
        })
        for (const [i, subtitle] of group.entries()) {
          outcomes.set(subtitle, await checkConverted(subtitle, files[i]!, hooks.onLog).catch((error) => unconverted(subtitle, error)))
        }
        continue
      } catch (error) {
        if (hooks.signal?.aborted) throw error
        const reason = firstLine(error)
        result.fallbacks.push({ input, reason })
        hooks.onLog?.(`la pasada única de ${group.length} subtítulos falló (${reason}): se convierten uno por uno`)
      }
    }
    for (const [i, subtitle] of group.entries()) {
      outcomes.set(subtitle, await extractOne(binaries, source, subtitle, encDir, hooks))
      if (input === source.path) hooks.onProgress?.(((i + 1) / group.length) * 100)
    }
  }

  // In plan order: it is the order of the tracks in the manifests
  for (const subtitle of subtitles) {
    const outcome = outcomes.get(subtitle)!
    if ('file' in outcome) {
      result.extracted.push(subtitle)
      result.files.push({ sourceIndex: subtitle.sourceIndex, file: outcome.file })
    } else {
      result.failed.push(outcome)
    }
  }
  return result
}

// A cue block has its "start --> end" timing line first, or second after an identifier
function isCueBlock(block: string): boolean {
  const [first = '', second = ''] = block.split('\n')
  return first.includes('-->') || second.includes('-->')
}

const NON_CUE_BLOCK = /^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/

// WebVTT ends a cue at the first empty line, so a cue whose text has an empty line inside
// (ASS "\N\N", common in anime signs) comes out of ffmpeg as the cue plus a stray block
// with no timing line. Players skip that block; Shaka aborts the whole run on it ("Failed
// to determine block classification"). A stray block goes back onto the cue it was cut
// from; one with no cue before it belongs to nothing and is dropped.
export function repairWebVtt(text: string): string {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n+$/, ''))
    .filter((block) => block.trim() !== '')
  const kept: string[] = []
  let repaired = false
  for (const block of blocks) {
    if (isCueBlock(block) || NON_CUE_BLOCK.test(block)) {
      kept.push(block)
      continue
    }
    repaired = true
    const previous = kept[kept.length - 1]
    if (previous !== undefined && isCueBlock(previous)) kept[kept.length - 1] = `${previous}\n${block}`
  }
  return repaired ? `${kept.join('\n\n')}\n` : text
}
