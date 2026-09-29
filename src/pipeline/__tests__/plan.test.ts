import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config'
import { COPY_LABEL, aacBitrateKbps, canCopyVideo, fitInBox, gopFrames, planAudio, planAudioTracks, planEncode, planExternalTrack, planSubtitle, unsupportedSourceReason, wouldUpscale } from '../plan'
import type { SourceAudio, SourceInfo, SourceSubtitle } from '../types'

const audio = (over: Partial<SourceAudio>): SourceAudio => ({
  index: 1,
  codec: 'aac',
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48000,
  bitrate: 128000,
  language: 'spa',
  title: null,
  isDefault: false,
  aacChannelConfig: null,
  ...over
})

const source = (over: Partial<SourceInfo['video']> = {}, extra: Partial<SourceInfo> = {}): SourceInfo => ({
  path: 'movie.mkv',
  sizeBytes: 1e9,
  durationSeconds: 5400,
  containerBitrate: null,
  video: {
    index: 0,
    codec: 'h264',
    width: 1920,
    height: 800,
    displayWidth: 1920,
    displayHeight: 800,
    fps: { num: 24000, den: 1001 },
    bitrate: 8_000_000,
    bitrateEstimated: false,
    pixelFormat: 'yuv420p',
    hdr: null,
    ...over
  },
  audio: [audio({})],
  subtitles: [],
  ...extra
})

const options = { rungs: DEFAULT_CONFIG.rungs, qualities: DEFAULT_CONFIG.qualities, segmentDurationSeconds: 6 }

describe('gopFrames', () => {
  it('snaps segment duration × fps to whole frames', () => {
    expect(gopFrames(6, { num: 24000, den: 1001 })).toBe(144)
    expect(gopFrames(6, { num: 25, den: 1 })).toBe(150)
    expect(gopFrames(2, { num: 30000, den: 1001 })).toBe(60)
    expect(gopFrames(4, { num: 24, den: 1 })).toBe(96)
  })
})

describe('fitInBox / wouldUpscale', () => {
  const box = (label: string) => DEFAULT_CONFIG.rungs[label]!

  it('keeps the aspect ratio of scope movies inside each box', () => {
    expect(fitInBox(1920, 800, box('1080p'))).toEqual({ width: 1920, height: 800 })
    expect(fitInBox(1920, 800, box('720p'))).toEqual({ width: 1280, height: 534 })
    expect(fitInBox(1920, 800, box('480p'))).toEqual({ width: 854, height: 356 })
  })

  it('handles 4:3 and 16:10 sources by whichever edge hits the box first', () => {
    expect(fitInBox(1440, 1080, box('1080p'))).toEqual({ width: 1440, height: 1080 })
    expect(fitInBox(1440, 1080, box('720p'))).toEqual({ width: 960, height: 720 })
    expect(fitInBox(1920, 1200, box('1080p'))).toEqual({ width: 1728, height: 1080 })
  })

  it('never scales up', () => {
    expect(fitInBox(1280, 720, box('2160p'))).toEqual({ width: 1280, height: 720 })
    expect(wouldUpscale(1600, 900, box('1080p'))).toBe(true)
    expect(wouldUpscale(1920, 800, box('1080p'))).toBe(false)
    expect(wouldUpscale(1440, 1080, box('1080p'))).toBe(false)
    expect(wouldUpscale(1920, 1080, box('1080p'))).toBe(false)
  })
})

describe('planEncode', () => {
  it('drops rungs that would upscale and keeps the configured order', () => {
    const plan = planEncode(source(), options)
    expect(plan.renditions.map((r) => r.label)).toEqual(['1080p', '720p', '480p'])
    expect(plan.skipped).toContainEqual({ kind: 'rendition', id: '2160p', reason: expect.stringContaining('upscaling') })
  })

  it('caps each rung at the source bitrate', () => {
    const plan = planEncode(source({ bitrate: 2_500_000 }), options)
    expect(plan.renditions.map((r) => [r.label, r.maxBitrateKbps])).toEqual([
      ['1080p', 2500],
      ['720p', 2500],
      ['480p', 1500]
    ])
  })

  it('uses the rung ceiling when the source bitrate is unknown', () => {
    const plan = planEncode(source({ bitrate: null }), { ...options, qualities: ['720p'] })
    expect(plan.renditions[0]?.maxBitrateKbps).toBe(3000)
  })

  it('derives GOP and the exact segment length from the frame rate', () => {
    const plan = planEncode(source(), options)
    expect(plan.renditions[0]?.gopFrames).toBe(144)
    expect(plan.actualSegmentSeconds).toBeCloseTo(6.006, 3)
  })

  it('skips unknown labels and plans text subtitles', () => {
    const plan = planEncode(
      source({}, { subtitles: [{ index: 3, codec: 'subrip', language: 'spa', title: null, isForced: false, isDefault: false, isImage: false }] }),
      { ...options, qualities: ['900p', '720p'] }
    )
    expect(plan.renditions.map((r) => r.label)).toEqual(['720p'])
    expect(plan.skipped.map((s) => s.kind)).toEqual(['rendition'])
    expect(plan.subtitles).toEqual([
      { sourceIndex: 3, input: { streamIndex: 3 }, sourceCodec: 'subrip', language: 'es', name: 'Español', title: null, forced: false, isDefault: false }
    ])
  })
})

describe('unsupportedSourceReason', () => {
  const hdr = (dolbyVisionProfile: number | null): SourceInfo =>
    source({ hdr: { transfer: 'pq', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020', colorSpace: 'bt2020nc', peakNits: 1000, dolbyVisionProfile } })

  it('refuses only Dolby Vision profile 5, which has no HDR10-compatible base layer', () => {
    expect(unsupportedSourceReason(hdr(5))).toMatch(/Dolby Vision perfil 5/)
    expect(unsupportedSourceReason(hdr(8))).toBeNull()
    expect(unsupportedSourceReason(hdr(7))).toBeNull()
    expect(unsupportedSourceReason(hdr(null))).toBeNull()
    expect(unsupportedSourceReason(source())).toBeNull()
  })
})

describe('planEncode native fallback', () => {
  it('serves the source at its own size when every enabled rung would upscale', () => {
    const plan = planEncode(source({ width: 640, height: 360, displayWidth: 640, displayHeight: 360, bitrate: 900_000 }), options)
    expect(plan.renditions).toEqual([
      { label: '360p', width: 640, height: 360, maxBitrateKbps: 900, gopFrames: 144, nativeFallback: true }
    ])
    expect(plan.skipped.filter((s) => s.kind === 'rendition')).toHaveLength(4)
  })

  it('takes the smallest enabled ceiling when the source bitrate is unknown', () => {
    const plan = planEncode(source({ width: 800, height: 334, displayWidth: 800, displayHeight: 334, bitrate: null }), options)
    expect(plan.renditions[0]).toMatchObject({ label: '334p', width: 800, height: 334, maxBitrateKbps: 1500 })
  })

  it('never produces a native rung when a configured one applies', () => {
    const plan = planEncode(source({ width: 854, height: 480, displayWidth: 854, displayHeight: 480 }), options)
    expect(plan.renditions.map((r) => r.label)).toEqual(['480p'])
    expect(plan.renditions[0]?.nativeFallback).toBeUndefined()
  })

  it('avoids clashing with an enabled label that happens to match the height', () => {
    const rungs = { ...DEFAULT_CONFIG.rungs, '360p': { width: 1280, height: 720, maxBitrateKbps: 2000 } }
    const plan = planEncode(source({ width: 640, height: 360, displayWidth: 640, displayHeight: 360 }), { ...options, rungs, qualities: ['360p'] })
    expect(plan.renditions[0]?.label).toBe('360p-native')
  })
})

describe('planSubtitle', () => {
  const subtitle = (over: Partial<SourceSubtitle>): SourceSubtitle => ({
    index: 5,
    codec: 'subrip',
    language: 'spa',
    title: null,
    isForced: false,
    isDefault: false,
    isImage: false,
    ...over
  })

  it('plans text tracks as WebVTT keeping forced/default flags and the display name', () => {
    expect(planSubtitle(subtitle({ codec: 'ass', isForced: true, isDefault: true, title: 'Forzados' }))).toEqual({
      sourceIndex: 5,
      input: { streamIndex: 5 },
      sourceCodec: 'ass',
      language: 'es',
      name: 'Forzados',
      title: 'Forzados',
      forced: true,
      isDefault: true
    })
    expect(planSubtitle(subtitle({ codec: 'mov_text', language: 'eng' }))).toMatchObject({ language: 'en', name: 'English' })
  })

  it('reports image subtitles as needing OCR instead of dropping them', () => {
    expect(planSubtitle(subtitle({ codec: 'hdmv_pgs_subtitle', isImage: true }))).toEqual({
      kind: 'subtitle',
      id: '5',
      reason: 'subtítulo de imagen (hdmv_pgs_subtitle): requiere OCR, no incluido'
    })
  })

  it('reports unsupported text formats', () => {
    expect(planSubtitle(subtitle({ codec: 'dvb_teletext' }))).toMatchObject({ kind: 'subtitle', reason: expect.stringContaining('no soportado') })
  })
})

describe('planAudio', () => {
  it('copies streamable codecs untouched', () => {
    expect(planAudio(audio({ codec: 'eac3', channels: 6, language: 'eng', isDefault: true }))).toEqual({
      sourceIndex: 1,
      input: { streamIndex: 1 },
      action: 'copy',
      sourceCodec: 'eac3',
      outputCodec: 'eac3',
      channels: 6,
      bitrateKbps: null,
      language: 'en',
      name: 'English',
      title: null,
      isDefault: true
    })
  })

  it('transcodes everything else to AAC keeping the channel count', () => {
    expect(planAudio(audio({ codec: 'dts', channels: 6, language: 'spa', title: 'Latino' }))).toMatchObject({
      action: 'transcode',
      outputCodec: 'aac',
      channels: 6,
      bitrateKbps: 384,
      language: 'es',
      name: 'Latino'
    })
    expect(planAudio(audio({ codec: 'flac', channels: 1 })).bitrateKbps).toBe(128)
  })

  it('encodes three channels and up as standard 5.1, the most every browser decodes', () => {
    // -ac 3 would be 2.1 with the dialogue in the LFE; 7 and 8 have no layout Chrome takes for sure
    expect([3, 4, 5, 6, 7, 8].map((channels) => planAudio(audio({ codec: 'dts', channels })).channels)).toEqual([6, 6, 6, 6, 6, 6])
    expect(planAudio(audio({ codec: 'truehd', channels: 8 })).bitrateKbps).toBe(384)
    // A Dolby 7.1 is copied as is; its AAC companion is 5.1
    expect(planAudioTracks(audio({ codec: 'eac3', channels: 8 })).map((a) => [a.outputCodec, a.channels])).toEqual([
      ['eac3', 8],
      ['aac', 6]
    ])
  })

  it('copies an AAC only with a standard channelConfiguration: Chrome does not parse a PCE', () => {
    // What left a movie black: an AAC 5.1(side) carries channelConfiguration 0 and a PCE, and
    // Chrome's MP4 demuxer fails the append. The extradata decides; the layout name only
    // when there is none (ADTS), since a hand-written PCE for 5.1 is reported as "5.1".
    const plans = [
      audio({ channels: 6, channelLayout: '5.1(side)', aacChannelConfig: 0 }),
      audio({ channels: 6, channelLayout: '5.1', aacChannelConfig: 0 }),
      audio({ channels: 2, channelLayout: 'stereo', aacChannelConfig: 0 }),
      audio({ channels: 8, channelLayout: '7.1', aacChannelConfig: 7 }),
      audio({ channels: 8, channelLayout: '7.1(wide)', aacChannelConfig: 0 }),
      audio({ channels: 8, channelLayout: '7.1', aacChannelConfig: 12 }),
      audio({ channels: 6, channelLayout: null }),
      audio({ channels: 6, channelLayout: '5.1(side)' }),
      audio({ channels: 6, channelLayout: '5.1' }),
      audio({ channels: 2, channelLayout: null }),
      audio({ channels: 1, channelLayout: null })
    ].map((track) => planAudio(track))
    expect(plans.map((p) => [p.action, p.channels])).toEqual([
      ['transcode', 6],
      ['transcode', 6],
      ['transcode', 2],
      ['copy', 8],
      ['transcode', 6],
      ['transcode', 6],
      ['transcode', 6],
      ['transcode', 6],
      ['copy', 6],
      ['copy', 2],
      ['copy', 1]
    ])
  })

  it('names untagged tracks as undetermined', () => {
    expect(planAudio(audio({ language: null }))).toMatchObject({ language: 'und', name: 'Desconocido' })
  })

  it('adds an AAC companion next to copied Dolby tracks only', () => {
    const dolby = planAudioTracks(audio({ codec: 'ac3', channels: 6, language: 'fra', title: 'VF' }))
    expect(dolby.map((a) => [a.action, a.outputCodec, a.channels, a.bitrateKbps, a.name])).toEqual([
      ['copy', 'ac3', 6, null, 'VF'],
      ['transcode', 'aac', 6, 384, 'VF']
    ])
    expect(planAudioTracks(audio({ codec: 'aac' }))).toHaveLength(1)
    expect(planAudioTracks(audio({ codec: 'dts' }))).toHaveLength(1)
    // External Dolby dubs get one too, keeping the user's language and name
    const external = planExternalTrack(
      { kind: 'audio', sourceIndex: -2, path: 'C:/in/dub.ac3', language: 'it', name: 'Italiano' },
      { path: 'C:/in/dub.ac3', audio: [audio({ codec: 'eac3', channels: 6 })], subtitles: [] }
    )
    expect(Array.isArray(external) && external.map((a) => [a.sourceIndex, a.outputCodec, a.language, a.name, a.input.path])).toEqual([
      [-2, 'eac3', 'it', 'Italiano', 'C:/in/dub.ac3'],
      [-2, 'aac', 'it', 'Italiano', 'C:/in/dub.ac3']
    ])
  })

  it('gives AAC rate to spare: 128k mono, 256k stereo, 64k per channel above', () => {
    expect([1, 2, 6, 8].map(aacBitrateKbps)).toEqual([128, 256, 384, 512])
  })
})

describe('copying the source video', () => {
  const copy = { ...options, copyVideo: { maxBitrateKbps: 12_000 } }

  it('copies 8-bit 4:2:0 H.264 SDR that fits under the ceiling, and nothing else', () => {
    expect(canCopyVideo(source(), 12_000)).toBe(true)
    expect(canCopyVideo(source({ pixelFormat: 'yuvj420p' }), 12_000)).toBe(true)
    expect(canCopyVideo(source({ bitrate: 13_000_000 }), 12_000)).toBe(false)
    expect(canCopyVideo(source({ bitrate: null }), 12_000)).toBe(false)
    expect(canCopyVideo(source({ codec: 'hevc' }), 12_000)).toBe(false)
    expect(canCopyVideo(source({ pixelFormat: 'yuv420p10le' }), 12_000)).toBe(false)
    // An 8-bit H.264 HLG capture would be an HDR copy next to a tone-mapped step
    const hlg = { transfer: 'hlg' as const, colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020', colorSpace: 'bt2020nc', peakNits: 1000, dolbyVisionProfile: null }
    expect(canCopyVideo(source({ hdr: hlg }), 12_000)).toBe(false)
  })

  it('publishes the source as "original" plus the smallest rung, keyframes aligned to the source', () => {
    const plan = planEncode(source(), copy)
    expect(plan.renditions).toEqual([
      { label: COPY_LABEL, width: 1920, height: 800, maxBitrateKbps: 8000, gopFrames: 144, copy: true },
      { label: '480p', width: 854, height: 356, maxBitrateKbps: 1500, gopFrames: 144 }
    ])
    expect(plan.keyframes).toBe('source')
    expect(plan.skipped.filter((s) => s.kind === 'rendition').map((s) => s.id)).toEqual(['2160p', '1080p', '720p'])
  })

  it('copies alone when the step would not really go down, or there is no height for it', () => {
    // 1.5 Mbps is more than 60 % of a 2 Mbps source: a worse copy nobody needs
    const slow = planEncode(source({ bitrate: 2_000_000 }), copy)
    expect(slow.renditions.map((r) => r.label)).toEqual([COPY_LABEL])
    expect(slow.skipped.find((s) => s.id === '480p')?.reason).toMatch(/no bajaría de verdad/)
    const small = planEncode(source({ width: 854, height: 480, displayWidth: 854, displayHeight: 480, bitrate: 4_000_000 }), copy)
    expect(small.renditions.map((r) => r.label)).toEqual([COPY_LABEL])
  })

  it('leaves the ladder alone when copying is not configured or does not apply', () => {
    expect(planEncode(source(), options).renditions.map((r) => r.label)).toEqual(['1080p', '720p', '480p'])
    expect(planEncode(source(), options).keyframes).toBeUndefined()
    expect(planEncode(source({ codec: 'hevc' }), copy).renditions.map((r) => r.label)).toEqual(['1080p', '720p', '480p'])
  })

  it('aligns new rungs of a copied title to the source keyframes', () => {
    const plan = planEncode(source(), { ...options, qualities: ['360p'], alignToSourceKeyframes: true, allowNativeFallback: false })
    expect(plan.renditions.map((r) => r.label)).toEqual(['360p'])
    expect(plan.keyframes).toBe('source')
  })
})
