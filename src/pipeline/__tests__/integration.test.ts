// End-to-end run with the real ffmpeg/ffprobe/packager binaries on a 6-second
// synthetic clip. Skipped when the binaries are not available.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config'
import { ProcessError, addToTitle, processTitle, resolveBinaries, type Binaries, type PipelineLogEvent, type ProgressEvent } from '..'
import { run } from '../exec'
import { extractSubtitles } from '../ffmpeg'
import { probeSource } from '../probe'
import { generateSample } from '../testing/sample'

let binaries: Binaries | undefined
try {
  binaries = resolveBinaries({ resourcesDir: resolve(__dirname, '../../../resources') })
} catch {
  binaries = undefined
}

describe.skipIf(!binaries)('pipeline (integration)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-it-'))
  const titleId = '00000000-0000-4000-8000-000000000001'
  const events: ProgressEvent[] = []
  const logs: string[] = []
  const described: PipelineLogEvent[] = []
  let outputFolder: string

  beforeAll(async () => {
    const sample = generateSample(binaries!.ffmpeg, { out: join(root, 'sample.mkv'), durationSeconds: 6 })
    const result = await processTitle(
      binaries!,
      {
        titleId,
        name: 'Sample',
        sourcePath: sample,
        outputRoot: join(root, 'out'),
        standards: ['hls', 'dash'],
        plan: { rungs: DEFAULT_CONFIG.rungs, qualities: DEFAULT_CONFIG.qualities, segmentDurationSeconds: 2 },
        videoEncoder: { preset: 'veryfast' }
      },
      { onProgress: (e) => events.push(e), onLog: (l) => logs.push(l), onEvent: (e) => described.push(e) }
    )
    outputFolder = result.outputFolder
  }, 120_000)

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('publishes the title folder with the documented layout and no leftovers', () => {
    expect(outputFolder).toBe(join(root, 'out', titleId))
    const files = readdirSync(outputFolder, { recursive: true }).map(String).map((f) => f.replace(/\\/g, '/')).sort()
    expect(files).toEqual(
      expect.arrayContaining([
        'master.m3u8',
        'manifest.mpd',
        'metadata.json',
        'video/1080p/playlist.m3u8',
        'video/720p/init.mp4',
        'video/720p/playlist.m3u8',
        'video/720p/seg_00001.m4s',
        'video/720p/seg_00003.m4s',
        'video/480p/playlist.m3u8',
        'audio/1_es_aac/playlist.m3u8',
        'audio/2_en_aac/playlist.m3u8',
        'audio/3_fr_ac3/playlist.m3u8',
        'audio/3_fr_aac/playlist.m3u8',
        'subs/4_es/playlist.m3u8',
        'subs/4_es/seg_00001.vtt',
        'subs/5_en/playlist.m3u8'
      ])
    )
    expect(existsSync(join(root, 'out', '.tmp'))).toBe(false)
  })

  it('cuts segments exactly on the GOP (2 s at 23.976 fps = 48 frames = 2.002 s)', () => {
    const playlist = readFileSync(join(outputFolder, 'video/720p/playlist.m3u8'), 'utf8')
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]))
    expect(durations.slice(0, -1).every((d) => Math.abs(d - 2.002) < 0.001)).toBe(true)
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"')
    expect(playlist).toContain('#EXT-X-ENDLIST')
  })

  it('exposes every audio track in the master playlist with language, name and channels', () => {
    const master = readFileSync(join(outputFolder, 'master.m3u8'), 'utf8')
    expect(master).toContain('LANGUAGE="es",NAME="Español",DEFAULT=YES')
    expect(master).toContain('LANGUAGE="en",NAME="English"')
    expect(master).toContain('CHANNELS="6"')
    // AC-3 is copied into its own group and also gets an AAC companion in the AAC group
    expect(master).toContain('URI="audio/3_fr_ac3/playlist.m3u8",GROUP-ID="audio-ac3",LANGUAGE="fr",NAME="Français"')
    expect(master).toContain('URI="audio/3_fr_aac/playlist.m3u8",GROUP-ID="audio-aac",LANGUAGE="fr",NAME="Français"')
    // One variant per rendition and group, each naming a single audio codec
    const variants = [...master.matchAll(/#EXT-X-STREAM-INF:([^\n]+)\n(\S+)/g)].map((m) => [m[2], m[1]!.match(/CODECS="([^"]+)"/)![1], m[1]!.match(/AUDIO="([^"]+)"/)![1]])
    expect(variants).toHaveLength(6)
    expect(variants.filter(([uri]) => uri === 'video/720p/playlist.m3u8').map(([, codecs, group]) => `${group}:${codecs}`).sort()).toEqual([
      'audio-aac:avc1.64001f,mp4a.40.2',
      'audio-ac3:avc1.64001f,ac-3'
    ])
  })

  it('converts text subtitles to WebVTT for both manifests, forced flag included, off by default', () => {
    const master = readFileSync(join(outputFolder, 'master.m3u8'), 'utf8')
    expect(master).toContain('TYPE=SUBTITLES,URI="subs/4_es/playlist.m3u8",GROUP-ID="subs",LANGUAGE="es",NAME="Español",DEFAULT=NO')
    expect(master).toContain('TYPE=SUBTITLES,URI="subs/5_en/playlist.m3u8",GROUP-ID="subs",LANGUAGE="en",NAME="Forced",DEFAULT=NO,AUTOSELECT=YES,FORCED=YES')
    expect(master).toMatch(/SUBTITLES="subs"/)

    const mpd = readFileSync(join(outputFolder, 'manifest.mpd'), 'utf8')
    expect(mpd).toContain('contentType="text" lang="es"')
    expect(mpd).toContain('<Role schemeIdUri="urn:mpeg:dash:role:2011" value="forced-subtitle"/>')
    expect(mpd).toContain('mimeType="text/vtt"')
    expect(mpd).toContain('media="subs/4_es/seg_$Number%05d$.vtt"')

    const cue = readFileSync(join(outputFolder, 'subs/4_es/seg_00001.vtt'), 'utf8')
    expect(cue).toMatch(/^WEBVTT/)
    expect(cue).toContain('Primer subtítulo')
  })

  it('describes the same segments in a static DASH manifest', () => {
    const mpd = readFileSync(join(outputFolder, 'manifest.mpd'), 'utf8')
    expect(mpd).toContain('type="static"')
    expect(mpd).toContain('profiles="urn:mpeg:dash:profile:isoff-live:2011"')
    for (const label of ['1080p', '720p', '480p']) {
      expect(mpd).toContain(`initialization="video/${label}/init.mp4" media="video/${label}/seg_$Number%05d$.m4s"`)
    }
    expect(mpd).toContain('lang="es"')
    expect(mpd).toContain('<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>')
    expect(mpd).toContain('audio_channel_configuration:2011" value="6"')
    // Track names travel to DASH as well, so players show "Español" instead of "es"
    expect(mpd).toContain('<Label>Español</Label>')
    expect(mpd).toContain('<Label>Français</Label>')
    expect(mpd).toContain('<Label>Forced</Label>')
    // One set of segments serves both manifests: every media/text segment on disk is listed by exactly one HLS media playlist
    const files = readdirSync(outputFolder, { recursive: true }).map(String)
    const segments = files.filter((f) => f.endsWith('.m4s') || f.endsWith('.vtt'))
    const listed = files
      .filter((f) => f.endsWith('playlist.m3u8'))
      .reduce((sum, f) => sum + (readFileSync(join(outputFolder, f), 'utf8').match(/#EXTINF/g)?.length ?? 0), 0)
    expect(segments.length).toBe(listed)
  })

  it('writes a metadata.json consistent with the output', () => {
    const metadata = JSON.parse(readFileSync(join(outputFolder, 'metadata.json'), 'utf8'))
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      titleId,
      name: 'Sample',
      standards: ['hls', 'dash'],
      manifests: { hls: 'master.m3u8', dash: 'manifest.mpd' },
      renditions: [
        { label: '1080p', width: 1920, height: 800, codec: 'h264', path: 'video/1080p' },
        { label: '720p', width: 1280, height: 534, codec: 'h264', path: 'video/720p' },
        { label: '480p', width: 854, height: 356, codec: 'h264', path: 'video/480p' }
      ],
      source: { path: join(root, 'sample.mkv'), width: 1920, height: 800, codec: 'h264' },
      audioTracks: [
        { id: '1_es_aac', language: 'es', codec: 'aac', channels: 2, path: 'audio/1_es_aac', sourceIndex: 1, sourceCodec: 'aac' },
        { id: '2_en_aac', language: 'en', codec: 'aac', channels: 6, path: 'audio/2_en_aac', sourceIndex: 2, sourceCodec: 'dts' },
        { id: '3_fr_ac3', language: 'fr', codec: 'ac3', channels: 2, path: 'audio/3_fr_ac3', sourceIndex: 3, sourceCodec: 'ac3' },
        { id: '3_fr_aac', language: 'fr', name: 'Français', codec: 'aac', channels: 2, path: 'audio/3_fr_aac', sourceIndex: 3, sourceCodec: 'ac3' }
      ],
      subtitleTracks: [
        { id: '4_es', language: 'es', name: 'Español', format: 'vtt', forced: false, path: 'subs/4_es', sourceIndex: 4, sourceFormat: 'subrip' },
        { id: '5_en', language: 'en', name: 'Forced', format: 'vtt', forced: true, path: 'subs/5_en', sourceIndex: 5, sourceFormat: 'ass' }
      ]
    })
    expect(metadata.source.fps).toBeCloseTo(23.976, 3)
    expect(metadata.dynamicRange).toEqual({ source: 'sdr', output: 'sdr' })
    expect(metadata.durationSeconds).toBeCloseTo(6, 0)
    expect(metadata.segmentDurationSeconds).toBeCloseTo(2.002, 3)
    // The synthetic clip is below the 1080p ceiling, so rule 1 caps the top rung at the source bitrate
    expect(metadata.renditions[0].maxBitrate).toBeLessThanOrEqual(6_000_000)
    expect(metadata.renditions.every((r: { bitrate: number }) => r.bitrate > 0)).toBe(true)
  })

  it('tone-maps an HDR10 source to BT.709 SDR and says so in the manifests and metadata', async () => {
    const hdrSample = generateSample(binaries!.ffmpeg, { out: join(root, 'hdr.mkv'), durationSeconds: 3, size: '960x400', hdr: true })
    const result = await processTitle(
      binaries!,
      {
        titleId: '00000000-0000-4000-8000-000000000003',
        name: 'HDR',
        sourcePath: hdrSample,
        outputRoot: join(root, 'out'),
        standards: ['hls', 'dash'],
        plan: { rungs: DEFAULT_CONFIG.rungs, qualities: ['480p', '360p'], segmentDurationSeconds: 2 },
        videoEncoder: { preset: 'veryfast' }
      }
    )
    expect(result.source.video.hdr).toEqual({
      transfer: 'pq',
      colorTransfer: 'smpte2084',
      colorPrimaries: 'bt2020',
      colorSpace: 'bt2020nc',
      peakNits: 800,
      dolbyVisionProfile: null
    })
    expect(result.metadata.dynamicRange).toEqual({ source: 'pq', output: 'sdr' })

    const master = readFileSync(join(result.outputFolder, 'master.m3u8'), 'utf8')
    expect(master).toContain('VIDEO-RANGE=SDR')
    expect(master).not.toContain('VIDEO-RANGE=PQ')
    const colour = execFileSync(binaries!.ffprobe, [
      '-v', 'error', '-allowed_extensions', 'ALL', '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt,color_primaries,color_transfer,color_space', '-of', 'csv=p=0',
      join(result.outputFolder, 'video/480p/playlist.m3u8')
    ]).toString().trim().split(/\r?\n/)[0]
    expect(colour).toBe('yuv420p,bt709,bt709,bt709')
  }, 120_000)

  it('falls back to a native rendition for sources smaller than every rung', async () => {
    const small = generateSample(binaries!.ffmpeg, { out: join(root, 'small.mkv'), durationSeconds: 3, size: '320x180' })
    const result = await processTitle(
      binaries!,
      {
        titleId: '00000000-0000-4000-8000-000000000002',
        name: 'Small',
        sourcePath: small,
        outputRoot: join(root, 'out'),
        standards: ['hls'],
        plan: { rungs: DEFAULT_CONFIG.rungs, qualities: DEFAULT_CONFIG.qualities, segmentDurationSeconds: 2 },
        videoEncoder: { preset: 'veryfast' }
      }
    )
    expect(result.plan.renditions).toEqual([expect.objectContaining({ label: '180p', width: 320, height: 180, nativeFallback: true })])
    expect(existsSync(join(result.outputFolder, 'video/180p/playlist.m3u8'))).toBe(true)
  }, 60_000)

  it('skips a subtitle ffmpeg cannot convert, or one without cues, instead of failing the whole job', async () => {
    const source = await probeSource(binaries!, join(root, 'sample.mkv'))
    const empty = join(root, 'empty.vtt')
    writeFileSync(empty, 'WEBVTT\n\n')
    const result = await extractSubtitles(
      binaries!,
      source,
      [
        { sourceIndex: 4, input: { streamIndex: 4 }, sourceCodec: 'subrip', language: 'es', name: 'Español', title: null, forced: false, isDefault: false },
        { sourceIndex: 99, input: { streamIndex: 99 }, sourceCodec: 'subrip', language: 'xx', name: 'Fantasma', title: null, forced: false, isDefault: false },
        { sourceIndex: -7, input: { path: empty, streamIndex: 0 }, sourceCodec: 'webvtt', language: 'xx', name: 'Vacío', title: null, forced: false, isDefault: false }
      ],
      root,
      {}
    )
    expect(result.extracted.map((s) => s.sourceIndex)).toEqual([4])
    expect(result.failed).toEqual([
      { kind: 'subtitle', id: '99', reason: expect.stringContaining('no se pudo convertir a WebVTT') },
      { kind: 'subtitle', id: '-7', reason: 'la pista no contiene ningún subtítulo' }
    ])
    expect(existsSync(join(root, 'sub_4.vtt'))).toBe(true)
  })

  it('adds a quality and external tracks to a published title, merging both manifests', async () => {
    const srt = join(root, 'extra.srt')
    writeFileSync(srt, ['1', '00:00:02,000 --> 00:00:05,000', 'Externo', ''].join('\n'))
    const dub = join(root, 'dub.m4a')
    execFileSync(binaries!.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '6', '-c:a', 'aac', '-ac', '2', dub])

    const before = readFileSync(join(outputFolder, 'video/720p/playlist.m3u8'), 'utf8')
    const result = await addToTitle(
      binaries!,
      {
        titleId,
        name: 'Sample',
        sourcePath: join(root, 'sample.mkv'),
        outputRoot: join(root, 'out'),
        rungs: DEFAULT_CONFIG.rungs,
        qualities: ['360p'],
        audioIndexes: [],
        subtitleIndexes: [],
        externalTracks: [
          { kind: 'subtitle', sourceIndex: -1, path: srt, language: 'de', name: 'Deutsch' },
          { kind: 'audio', sourceIndex: -2, path: dub, language: 'it', name: 'Italiano' }
        ],
        videoEncoder: { preset: 'veryfast' }
      }
    )

    // Existing segments untouched, new folders in place
    expect(readFileSync(join(outputFolder, 'video/720p/playlist.m3u8'), 'utf8')).toBe(before)
    expect(existsSync(join(outputFolder, 'video/360p/playlist.m3u8'))).toBe(true)
    expect(existsSync(join(outputFolder, 'audio/e2_it_aac/playlist.m3u8'))).toBe(true)
    expect(existsSync(join(outputFolder, 'subs/e1_de/seg_00001.vtt'))).toBe(true)
    expect(existsSync(join(root, 'out', '.tmp'))).toBe(false)

    // Segment length matches the published GOP exactly
    const durations = [...readFileSync(join(outputFolder, 'video/360p/playlist.m3u8'), 'utf8').matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]))
    expect(durations.slice(0, -1).every((d) => Math.abs(d - 2.002) < 0.001)).toBe(true)

    const master = readFileSync(join(outputFolder, 'master.m3u8'), 'utf8')
    // 1920×800 inside 640×360 → 640×266.7, rounded to even
    expect(master).toContain('RESOLUTION=640x268')
    expect(master).toContain('URI="audio/e2_it_aac/playlist.m3u8",GROUP-ID="audio-aac",LANGUAGE="it",NAME="Italiano",DEFAULT=NO')
    expect(master).toContain('URI="subs/e1_de/playlist.m3u8",GROUP-ID="subs",LANGUAGE="de",NAME="Deutsch"')
    expect(master).toContain('LANGUAGE="es",NAME="Español",DEFAULT=YES')
    // 4 renditions × 2 audio groups; the new rendition's bandwidth comes from its segments
    const variants = [...master.matchAll(/#EXT-X-STREAM-INF:([^\n]+)\n(\S+)/g)].map((m) => ({ uri: m[2]!, attrs: m[1]! }))
    expect(variants).toHaveLength(8)
    const small = variants.filter((v) => v.uri === 'video/360p/playlist.m3u8')
    expect(small.map((v) => v.attrs.match(/AUDIO="([^"]+)"/)![1]).sort()).toEqual(['audio-aac', 'audio-ac3'])
    for (const v of small) {
      expect(Number(v.attrs.match(/BANDWIDTH=(\d+)/)![1])).toBeGreaterThan(100_000)
      expect(v.attrs).toContain('SUBTITLES="subs"')
    }

    const mpd = readFileSync(join(outputFolder, 'manifest.mpd'), 'utf8')
    expect(mpd).toContain('initialization="video/360p/init.mp4"')
    expect(mpd).toContain('lang="it"')
    expect(mpd).toContain('lang="de"')
    expect(mpd).toContain('<Label>Italiano</Label>')
    expect(mpd).toContain('<Label>Deutsch</Label>')
    const ids = [...mpd.matchAll(/<Representation id="(\d+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)

    const metadata = JSON.parse(readFileSync(join(outputFolder, 'metadata.json'), 'utf8'))
    expect(metadata.renditions.map((r: { label: string }) => r.label)).toEqual(['1080p', '720p', '480p', '360p'])
    expect(metadata.audioTracks.map((a: { id: string }) => a.id)).toContain('e2_it_aac')
    expect(metadata.subtitleTracks.map((s: { id: string }) => s.id)).toContain('e1_de')
    expect(result.metadata).toEqual(metadata)

    // Both manifests still parse with everything in them
    const probe = (file: string): string =>
      execFileSync(binaries!.ffprobe, ['-v', 'error', '-allowed_extensions', 'ALL', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).toString()
    expect(probe(join(outputFolder, 'master.m3u8'))).toContain('video')
    expect(probe(join(outputFolder, 'manifest.mpd'))).toContain('subtitle')
  }, 120_000)

  it('refuses additions that already exist or would upscale', async () => {
    const base = { titleId, name: 'Sample', sourcePath: join(root, 'sample.mkv'), outputRoot: join(root, 'out'), rungs: DEFAULT_CONFIG.rungs, audioIndexes: [], subtitleIndexes: [], externalTracks: [] }
    await expect(addToTitle(binaries!, { ...base, qualities: ['720p'] })).rejects.toThrow(/Ya existe en el título: calidad 720p/)
    await expect(addToTitle(binaries!, { ...base, qualities: ['2160p'] })).rejects.toThrow(/upscaling/)
    expect(existsSync(join(root, 'out', '.tmp'))).toBe(false)
  })

  it('replaces a published title in place on a full reprocess, keeping external tracks', async () => {
    const result = await processTitle(
      binaries!,
      {
        titleId,
        name: 'Sample',
        sourcePath: join(root, 'sample.mkv'),
        outputRoot: join(root, 'out'),
        standards: ['hls'],
        plan: { rungs: DEFAULT_CONFIG.rungs, qualities: ['480p'], segmentDurationSeconds: 3 },
        externalTracks: [{ kind: 'subtitle', sourceIndex: -1, path: join(root, 'extra.srt'), language: 'de', name: 'Deutsch' }],
        replaceExisting: true,
        videoEncoder: { preset: 'veryfast' }
      }
    )
    expect(result.outputFolder).toBe(outputFolder)
    expect(readdirSync(join(outputFolder, 'video'))).toEqual(['480p'])
    expect(existsSync(join(outputFolder, 'manifest.mpd'))).toBe(false)
    expect(existsSync(join(outputFolder, 'subs/e1_de/playlist.m3u8'))).toBe(true)
    expect(existsSync(`${outputFolder}.old`)).toBe(false)
    expect(JSON.parse(readFileSync(join(outputFolder, 'metadata.json'), 'utf8')).segmentDurationSeconds).toBeCloseTo(3.003, 3)
  }, 120_000)

  it('leaves nothing behind when a run fails', async () => {
    await expect(
      processTitle(binaries!, {
        titleId: '00000000-0000-4000-8000-00000000dead',
        name: 'Missing',
        sourcePath: join(root, 'does-not-exist.mkv'),
        outputRoot: join(root, 'out'),
        standards: ['hls'],
        plan: { rungs: DEFAULT_CONFIG.rungs, qualities: ['720p'], segmentDurationSeconds: 6 }
      })
    ).rejects.toBeInstanceOf(ProcessError)
    expect(existsSync(join(root, 'out', '00000000-0000-4000-8000-00000000dead'))).toBe(false)
    expect(existsSync(join(root, 'out', '.tmp'))).toBe(false)
  })

  it('kills the child process when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = run(binaries!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=64x64', '-t', '60', '-f', 'null', '-'], {
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 200)
    await expect(pending).rejects.toMatchObject({ name: 'ProcessError', aborted: true })
  })

  it('describes what it found, decided and produced through onEvent', () => {
    const messages = described.map((e) => `${e.level}: ${e.message}`)
    expect(messages[0]).toMatch(/^info: Origen analizado: 1920×800 h264 a 23\.976 fps, [\d,]+ Mbps \(estimado\), 0 min 06 s, 3 pista\(s\) de audio, 2 subtítulo\(s\)$/)
    expect(described[0]!.context).toMatchObject({ video: { codec: 'h264', displayWidth: 1920, displayHeight: 800, hdr: null } })
    expect((described[0]!.context!.audio as unknown[]).length).toBe(3)
    expect(messages).toContainEqual(expect.stringMatching(/^info: Plan: 3 calidad\(es\) \[1080p 1920×800 ≤\d+ kbps; 720p 1280×534 ≤\d+ kbps; 480p 854×356 ≤\d+ kbps\], 4 pista\(s\) de audio de salida \[1_es_aac aac copiado 2ch; 2_en_aac dts → aac 6ch; 3_fr_ac3 ac3 copiado 2ch; 3_fr_aac ac3 → aac 2ch\], 2 subtítulo\(s\) \[4_es subrip; 5_en ass forzado\]; segmentos de 2\.002 s$/))
    expect(messages).toContainEqual(expect.stringMatching(/^warn: Omitido: calidad 2160p \(el origen .* sería upscaling\)$/))
    expect(messages).toContainEqual(expect.stringMatching(/^info: Subtítulos convertidos a WebVTT: /))
    expect(messages).toContainEqual(expect.stringMatching(/^debug: Comando ffmpeg: ffmpeg .*-filter_complex/))
    expect(messages).toContainEqual(expect.stringMatching(/^info: Codificación terminada: \d+ archivo\(s\), [\d,]+ (KB|MB)$/))
    expect(messages).toContainEqual(expect.stringMatching(/^debug: Comando packager: packager /))
    expect(messages).toContainEqual(expect.stringMatching(/^info: Empaquetado terminado: \d+ flujo\(s\) en HLS \+ DASH, ~\d+ segmentos$/))
    expect(messages[messages.length - 1]).toMatch(/^info: Publicado en .* \([\d,]+ (KB|MB)\)$/)
    const published = described[described.length - 1]!.context!
    expect(published).toMatchObject({ outputFolder, replaced: false, standards: ['hls', 'dash'], manifests: { hls: 'master.m3u8', dash: 'manifest.mpd' } })
    expect(published.bytes as number).toBeGreaterThan(100_000)
    const encoded = described.find((e) => e.message.startsWith('Codificación terminada'))!.context!.files as { stream: string; bytes: number }[]
    expect(encoded.map((f) => f.stream)).toEqual(expect.arrayContaining(['1080p', '720p', '480p']))
    expect(encoded.every((f) => f.bytes > 0)).toBe(true)
  })

  it('reports monotonic progress through every step', () => {
    const steps = [...new Set(events.map((e) => e.step))]
    expect(steps).toEqual(['probe', 'plan', 'encode', 'package', 'publish'])
    const percents = events.map((e) => e.percent)
    expect(percents.every((p, i) => i === 0 || p >= percents[i - 1]!)).toBe(true)
    expect(percents.at(-1)).toBe(100)
    expect(logs.some((l) => l.includes('omitido rendition 2160p'))).toBe(true)
  })
})
