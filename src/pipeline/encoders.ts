import type { EncodePlan, RenditionPlan } from './types'

// H.264 encoders the pipeline knows how to drive. Order = preference when several work.
export type EncoderKind = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_vaapi' | 'h264_videotoolbox' | 'libx264'

export interface EncoderSpec {
  kind: EncoderKind
  label: string
  hardware: boolean
  platforms: NodeJS.Platform[]
}

export const ENCODERS: EncoderSpec[] = [
  { kind: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true, platforms: ['win32', 'linux'] },
  { kind: 'h264_qsv', label: 'Intel Quick Sync', hardware: true, platforms: ['win32', 'linux'] },
  { kind: 'h264_amf', label: 'AMD AMF', hardware: true, platforms: ['win32'] },
  { kind: 'h264_vaapi', label: 'VAAPI', hardware: true, platforms: ['linux'] },
  { kind: 'h264_videotoolbox', label: 'Apple VideoToolbox', hardware: true, platforms: ['darwin'] },
  { kind: 'libx264', label: 'CPU (libx264)', hardware: false, platforms: ['win32', 'linux', 'darwin'] }
]

export const SOFTWARE_ENCODER: EncoderKind = 'libx264'
export const VAAPI_DEVICE = '/dev/dri/renderD128'

export const encoderSpec = (kind: EncoderKind): EncoderSpec => ENCODERS.find((e) => e.kind === kind)!
export const isHardwareEncoder = (kind: EncoderKind): boolean => encoderSpec(kind).hardware

export interface QualityOptions {
  // libx264 preset and CRF; hardware encoders map them to their own constant-quality knobs
  preset: string
  crf: number
}

// Global ffmpeg options an encoder needs before any input (VAAPI must open its device)
export function encoderGlobalArgs(kind: EncoderKind): string[] {
  return kind === 'h264_vaapi' ? ['-vaapi_device', VAAPI_DEVICE] : []
}

// Decoder options placed before the title input. NVENC machines also decode on the
// GPU (NVDEC), which frees the CPU for the filters; frames stay in system memory
// so the filter graph is the same, and ffmpeg falls back to software decoding by
// itself when NVDEC does not support the source (it logs "Failed setup for format cuda").
export function encoderInputArgs(kind: EncoderKind): string[] {
  return kind === 'h264_nvenc' ? ['-hwaccel', 'cuda'] : []
}

// Filter tail appended after scaling: VAAPI encodes from GPU surfaces
export function encoderFilterSuffix(kind: EncoderKind): string {
  return kind === 'h264_vaapi' ? ',format=nv12,hwupload' : ''
}

// Every encoder gets the same contract: capped constant quality, fixed GOP with no
// scene-cut keyframes, constant frame rate, High profile, 8-bit 4:2:0.
//
// Next to a copied rendition the keyframes go exactly where the source has them and
// nowhere else, so both renditions cut on the same boundaries; the frame rate is left
// alone for the same reason (a CFR conversion would move frames around them).
export function videoCodecArgs(kind: EncoderKind, rendition: RenditionPlan, plan: EncodePlan, quality: QualityOptions): string[] {
  const { gopFrames, maxBitrateKbps } = rendition
  const aligned = plan.keyframes === 'source'
  const cap = ['-maxrate', `${maxBitrateKbps}k`, '-bufsize', `${maxBitrateKbps * 2}k`]
  const gop = aligned ? ['-force_key_frames', 'source', '-g', '9999'] : ['-g', String(gopFrames), '-keyint_min', String(gopFrames)]
  const rate = aligned ? [] : ['-r', `${plan.fps.num}/${plan.fps.den}`, '-fps_mode', 'cfr']
  const pixfmt = kind === 'h264_vaapi' ? [] : ['-pix_fmt', 'yuv420p']

  switch (kind) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', quality.preset, '-profile:v', 'high', ...pixfmt, '-crf', String(quality.crf), ...cap, ...gop, '-sc_threshold', '0', ...rate]
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-profile:v', 'high', ...pixfmt, '-rc', 'vbr', '-cq', String(quality.crf + 3), '-b:v', '0', ...cap, ...gop, '-no-scenecut', '1', '-forced-idr', '1', ...rate]
    case 'h264_qsv':
      // global_quality + maxrate selects QVBR (quality-defined VBR under a ceiling). A forced
      // keyframe is a plain I frame for Quick Sync unless forced_idr says otherwise, and a
      // segment can only start on an IDR.
      return ['-c:v', 'h264_qsv', '-preset', 'slower', '-profile:v', 'high', ...pixfmt, '-global_quality', String(quality.crf + 3), '-b:v', `${maxBitrateKbps}k`, ...cap, ...gop, ...(aligned ? ['-forced_idr', '1'] : []), '-scenario', 'archive', ...rate]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'quality', '-profile:v', 'high', ...pixfmt, '-rc', 'vbr_peak', '-b:v', `${maxBitrateKbps}k`, ...cap, ...gop, ...rate]
    case 'h264_vaapi':
      return ['-c:v', 'h264_vaapi', '-profile:v', 'high', '-rc_mode', 'VBR', '-b:v', `${maxBitrateKbps}k`, ...cap, ...gop, ...rate]
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', ...pixfmt, '-b:v', `${maxBitrateKbps}k`, ...cap, ...gop, '-allow_sw', '0', ...rate]
  }
}

// One-second synthetic encode: proves the driver and device actually work, not just that ffmpeg was built with it
export function probeArgs(kind: EncoderKind): string[] {
  const filter = `scale=320:240${encoderFilterSuffix(kind)}`
  const plan = { fps: { num: 30, den: 1 } } as EncodePlan
  const rendition: RenditionPlan = { label: 'probe', width: 320, height: 240, maxBitrateKbps: 1000, gopFrames: 30 }
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...encoderGlobalArgs(kind),
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '1',
    '-vf', filter,
    ...videoCodecArgs(kind, rendition, plan, { preset: 'ultrafast', crf: 23 }),
    '-f', 'null', '-'
  ]
}
