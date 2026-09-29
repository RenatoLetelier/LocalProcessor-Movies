// What the pipeline must keep from the source, checked against the real binaries:
// the video copied bit for bit next to an aligned encoded step, an AAC with a PCE
// never reaching Chrome, and HDR tone-mapped without greying out or clipping.
// Ported from the lc-fileserver HLS tests that caught each of these in production.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Rung } from '@shared/config'
import { processTitle, resolveBinaries, type Binaries } from '..'
import { aacChannelConfiguration } from '../aac'
import { probeSource } from '../probe'

let binaries: Binaries | undefined
try {
  binaries = resolveBinaries({ resourcesDir: resolve(__dirname, '../../../resources') })
} catch {
  binaries = undefined
}

const ffmpeg = (args: string[]): string => execFileSync(binaries!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 26 }).toString()
// -allowed_extensions belongs to the HLS demuxer: the published playlists need it, anything else rejects it
const hls = (file: string): string[] => (file.endsWith('.m3u8') ? ['-allowed_extensions', 'ALL'] : [])
const ffprobe = (args: string[]): string => execFileSync(binaries!.ffprobe, ['-v', 'error', ...hls(args.at(-1)!), ...args], { maxBuffer: 1 << 26 }).toString()

// Sum of the packet sizes of one stream: equal sums mean the stream was copied, not re-encoded
const packetBytes = (file: string, stream: string): number =>
  ffprobe(['-select_streams', stream, '-show_entries', 'packet=size', '-of', 'csv=p=0', file])
    .split(/\r?\n/)
    .filter(Boolean)
    // A .ts adds an empty column: "12846,"
    .reduce((total, line) => total + Number.parseInt(line, 10), 0)

// MD5 of every decoded frame: equal lists mean the stream was not re-encoded, whatever the
// container did to the bitstream (a .ts carries Annex B start codes and ADTS headers)
const frameHashes = (file: string, stream = 'v:0'): string[] =>
  ffmpeg([...hls(file), '-i', file, '-map', `0:${stream}`, '-f', 'framemd5', '-'])
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1)!.trim())

const segmentDurations = (playlist: string): number[] =>
  [...readFileSync(playlist, 'utf8').matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000) / 1000)

// channelConfiguration of the AudioSpecificConfig inside the esds box of an init segment:
// 1 to 7 are the standard MPEG-4 layouts, 0 means "PCE", which Chrome cannot parse.
// ffprobe does not show it, so the box is walked by hand.
function initChannelConfiguration(initPath: string): number {
  const b = readFileSync(initPath)
  const size = (i: number): [number, number] => {
    let n = 0
    for (;;) {
      const c = b[i++]!
      n = (n << 7) | (c & 0x7f)
      if (!(c & 0x80)) return [n, i]
    }
  }
  let i = b.indexOf('esds') + 4 + 4
  expect(b[i]).toBe(0x03) // ES_Descriptor
  ;[, i] = size(i + 1)
  i += 3
  expect(b[i]).toBe(0x04) // DecoderConfigDescriptor
  ;[, i] = size(i + 1)
  i += 13
  expect(b[i]).toBe(0x05) // DecoderSpecificInfo
  let length: number
  ;[length, i] = size(i + 1)
  const cc = aacChannelConfiguration(b.subarray(i, i + length))
  expect(cc).not.toBeNull()
  return cc!
}

// Mean and peak luma (0-255) over every frame, with signalstats
function luma(input: string, filter = '', lavfi = false): { mean: number; max: number } {
  const out = ffmpeg([...(lavfi ? ['-f', 'lavfi'] : hls(input)), '-i', input, '-vf', `${filter}${filter ? ',' : ''}signalstats,metadata=print:file=-`, '-f', 'null', '-'])
  const means = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  const peaks = [...out.matchAll(/YMAX=([\d.]+)/g)].map((m) => Number(m[1]))
  expect(means.length).toBeGreaterThan(0)
  return { mean: means.reduce((a, v) => a + v, 0) / means.length, max: Math.max(...peaks) }
}

const RUNG_240: Record<string, Rung> = { '240p': { width: 426, height: 240, maxBitrateKbps: 40 } }

describe.skipIf(!binaries)('fidelity (integration)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-fidelity-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('copies the source video bit for bit, cuts the encoded step on the same boundaries, and copies an ADTS AAC', async () => {
    // 14 s with a keyframe every 2 s, in a .ts: the AAC arrives with ADTS headers
    const source = join(root, 'copy.ts')
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=14', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-metadata:s:a:0', 'language=spa', source
    ])
    const result = await processTitle(binaries!, {
      titleId: '00000000-0000-4000-8000-00000000c0b1',
      name: 'Copia',
      sourcePath: source,
      outputRoot: join(root, 'out'),
      standards: ['hls', 'dash'],
      plan: { rungs: RUNG_240, qualities: ['240p'], segmentDurationSeconds: 6, copyVideo: { maxBitrateKbps: 100_000 } },
      videoEncoder: { preset: 'veryfast' }
    })
    const dir = result.outputFolder

    expect(result.plan.renditions.map((r) => [r.label, r.copy ?? false])).toEqual([
      ['original', true],
      ['240p', false]
    ])
    expect(result.metadata.renditions.map((r) => [r.label, r.copied ?? false, r.height])).toEqual([
      ['original', true, 360],
      ['240p', false, 240]
    ])
    const copied = frameHashes(join(dir, 'video/original/playlist.m3u8'))
    expect(copied.length).toBe(14 * 24)
    expect(copied).toEqual(frameHashes(source))

    const original = segmentDurations(join(dir, 'video/original/playlist.m3u8'))
    expect(original.length).toBeGreaterThanOrEqual(2)
    expect(segmentDurations(join(dir, 'video/240p/playlist.m3u8'))).toEqual(original)

    expect(result.plan.audio.map((a) => a.action)).toEqual(['copy'])
    // Copied: the same audio, 7 bytes of ADTS header lighter per frame
    const audio = frameHashes(join(dir, 'audio/1_es_aac/playlist.m3u8'), 'a:0')
    expect(audio).toEqual(frameHashes(source, 'a:0'))
    expect(packetBytes(source, 'a') - packetBytes(join(dir, 'audio/1_es_aac/playlist.m3u8'), 'a')).toBe(7 * audio.length)
    expect(initChannelConfiguration(join(dir, 'audio/1_es_aac/init.mp4'))).toBe(1)

    const master = readFileSync(join(dir, 'master.m3u8'), 'utf8')
    expect(master).toMatch(/RESOLUTION=640x360[^\n]*\nvideo\/original\/playlist\.m3u8/)
    expect(ffprobe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', join(dir, 'manifest.mpd')])).toContain('video')
  }, 120_000)

  it('re-encodes an AAC with a PCE to standard 5.1, and never lets ffmpeg write one', async () => {
    // A 5.1(side) layout through the aac encoder without -ac: channelConfiguration 0 plus a
    // PCE, as the old lc-fileserver ladder left a movie that stayed black in Chrome
    const source = join(root, 'pce.mp4')
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-filter_complex', '[1:a]aformat=channel_layouts=5.1(side)[a]', '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-metadata:s:a:0', 'language=eng', source
    ])
    const probed = await probeSource(binaries!, source)
    expect(probed.audio[0]).toMatchObject({ codec: 'aac', channels: 6, aacChannelConfig: 0 })

    const result = await processTitle(binaries!, {
      titleId: '00000000-0000-4000-8000-0000000000ce',
      name: 'PCE',
      sourcePath: source,
      outputRoot: join(root, 'out'),
      standards: ['hls'],
      plan: { rungs: RUNG_240, qualities: ['240p'], segmentDurationSeconds: 2 },
      videoEncoder: { preset: 'veryfast' }
    })
    expect(result.plan.audio.map((a) => [a.action, a.channels])).toEqual([['transcode', 6]])
    expect(initChannelConfiguration(join(result.outputFolder, 'audio/1_en_aac/init.mp4'))).toBe(6)
  }, 120_000)

  it('tone-maps HDR10 to BT.709: not grey like truncated PQ, highlights not clipped, no HDR10 metadata left', async () => {
    // A real PQ/BT.2020 clip built from an SDR pattern with white at 400 nits and HDR10
    // mastering metadata: there are highlights above SDR that a clip would saturate and
    // truncated PQ leaves grey, and side data that must not reach the H.264.
    const pattern = 'testsrc2=size=320x240:rate=15:duration=2'
    const source = join(root, 'hdr.mp4')
    ffmpeg([
      '-f', 'lavfi', '-i', pattern, '-map', '0:v',
      '-vf', 'zscale=tin=bt709:pin=bt709:min=bt709:rin=tv:t=linear:npl=100:p=bt2020,format=gbrpf32le,zscale=t=smpte2084:m=bt2020nc:r=tv:npl=400,format=yuv420p10le',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params',
      'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50):max-cll=4000,1000:log-level=error',
      // A rendition never exceeds the source bitrate: starved at x265's default for this
      // pattern (~60 kbps), the H.264 rings and the peak luma measures the artefacts
      '-b:v', '1500k', '-tag:v', 'hvc1', source
    ])
    const result = await processTitle(binaries!, {
      titleId: '00000000-0000-4000-8000-000000000d10',
      name: 'HDR',
      sourcePath: source,
      outputRoot: join(root, 'out'),
      standards: ['hls'],
      plan: { rungs: { '240p': { width: 426, height: 240, maxBitrateKbps: 2000 } }, qualities: ['240p'], segmentDurationSeconds: 2 },
      videoEncoder: { preset: 'veryfast' }
    })
    const playlist = join(result.outputFolder, 'video/240p/playlist.m3u8')
    expect(ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_primaries,color_transfer,color_space', '-of', 'csv=p=0', playlist]).trim().split(/\r?\n/)[0]).toBe(
      'yuv420p,bt709,bt709,bt709'
    )

    // Measured with this pattern (lc-fileserver): SDR reference mean 123 and peak 210;
    // truncated PQ mean 124 but peak 163, all grey; a plain zscale without tonemap
    // saturates the 400-nit white (peak 255). Thresholds leave room for zimg builds.
    const sdr = luma(pattern, '', true)
    const mapped = luma(playlist)
    const truncated = luma(source, 'format=yuv420p')
    expect(Math.abs(mapped.mean - sdr.mean)).toBeLessThan(15)
    expect(mapped.max).toBeLessThan(240)
    expect(mapped.max).toBeGreaterThan(truncated.max + 20)

    const init = readFileSync(join(result.outputFolder, 'video/240p/init.mp4'))
    expect(init.indexOf('mdcv')).toBe(-1)
    expect(init.indexOf('clli')).toBe(-1)
    expect(init.indexOf('colr')).toBeGreaterThan(0)
  }, 120_000)

  it('publishes with the names and default track a catalog asked for', async () => {
    const result = await processTitle(binaries!, {
      titleId: '00000000-0000-4000-8000-0000000000aa',
      name: 'Catálogo',
      sourcePath: join(root, 'copy.ts'),
      outputRoot: join(root, 'out'),
      standards: ['hls', 'dash'],
      plan: { rungs: RUNG_240, qualities: ['240p'], segmentDurationSeconds: 6 },
      videoEncoder: { preset: 'veryfast' },
      trackOverrides: { audio: [{ sourceIndex: 1, name: 'Español latino', language: 'es-419' }] }
    })
    const master = readFileSync(join(result.outputFolder, 'master.m3u8'), 'utf8')
    expect(master).toContain('LANGUAGE="es-419",NAME="Español latino",DEFAULT=YES')
    expect(readFileSync(join(result.outputFolder, 'manifest.mpd'), 'utf8')).toContain('<Label>Español latino</Label>')
    expect(result.metadata.audioTracks[0]).toMatchObject({ name: 'Español latino', language: 'es-419', default: true, original: { name: 'Español', language: 'es' } })
    expect(ffprobe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', join(result.outputFolder, 'master.m3u8')])).toContain('audio')
  }, 120_000)
})
