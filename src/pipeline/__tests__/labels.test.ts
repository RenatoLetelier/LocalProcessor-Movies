import { describe, expect, it } from 'vitest'
import { labelMaster, labelMpd, labelTracks } from '../labels'
import type { TitleMetadata } from '../types'

// Manifests as Shaka Packager 3.9 writes them for the synthetic sample (trimmed)
const MASTER = `#EXTM3U
## Generated with https://github.com/shaka-project/shaka-packager version v3.9.3-0a8ba4f-release

#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/1_es_aac/playlist.m3u8",GROUP-ID="audio-aac",LANGUAGE="es",NAME="Español",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/2_en_aac/playlist.m3u8",GROUP-ID="audio-aac",LANGUAGE="en",NAME="English",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="6"
#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/3_fr_ac3/playlist.m3u8",GROUP-ID="audio-ac3",LANGUAGE="fr",NAME="Français",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/3_fr_aac/playlist.m3u8",GROUP-ID="audio-aac",LANGUAGE="fr",NAME="Français",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2"

#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs/4_es/playlist.m3u8",GROUP-ID="subs",LANGUAGE="es",NAME="Español",DEFAULT=NO,AUTOSELECT=YES
#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs/5_en/playlist.m3u8",GROUP-ID="subs",LANGUAGE="en",NAME="Forced",DEFAULT=NO,AUTOSELECT=YES,FORCED=YES

#EXT-X-STREAM-INF:BANDWIDTH=1824860,AVERAGE-BANDWIDTH=1747782,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x534,FRAME-RATE=23.976,AUDIO="audio-aac",SUBTITLES="subs",CLOSED-CAPTIONS=NONE
video/720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1775027,AVERAGE-BANDWIDTH=1698382,CODECS="avc1.64001f,ac-3",RESOLUTION=1280x534,FRAME-RATE=23.976,AUDIO="audio-ac3",SUBTITLES="subs",CLOSED-CAPTIONS=NONE
video/720p/playlist.m3u8
`

const adaptationSet = (id: number, type: string, lang: string, role: string | null, label: string, dir: string, init = true): string => `    <AdaptationSet id="${id}" contentType="${type}" lang="${lang}" segmentAlignment="true">
${role ? `      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="${role}"/>\n` : ''}      <Label>${label}</Label>
      <Representation id="${id}" bandwidth="1000" mimeType="${type === 'text' ? 'text/vtt' : 'audio/mp4'}">
        <SegmentTemplate timescale="1000" ${init ? `initialization="${dir}/init.mp4" ` : ''}media="${dir}/seg_$Number%05d$.${type === 'text' ? 'vtt' : 'm4s'}" startNumber="1"/>
      </Representation>
    </AdaptationSet>`

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT6.006S">
  <Period id="0">
    <AdaptationSet id="9" contentType="video" maxWidth="1280" maxHeight="534">
      <Representation id="9" bandwidth="1579709" codecs="avc1.64001f" mimeType="video/mp4" width="1280" height="534">
        <SegmentTemplate timescale="24000" initialization="video/720p/init.mp4" media="video/720p/seg_$Number%05d$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
${adaptationSet(5, 'audio', 'es', 'main', 'Español', 'audio/1_es_aac')}
${adaptationSet(3, 'audio', 'en', null, 'English', 'audio/2_en_aac')}
${adaptationSet(4, 'audio', 'fr', null, 'Français', 'audio/3_fr_ac3')}
${adaptationSet(6, 'audio', 'fr', null, 'Français', 'audio/3_fr_aac')}
${adaptationSet(1, 'text', 'es', 'subtitle', 'Español', 'subs/4_es', false)}
${adaptationSet(0, 'text', 'en', 'forced-subtitle', 'Forced', 'subs/5_en', false)}
  </Period>
</MPD>
`

const audioTrack = (id: string, sourceIndex: number, language: string, name: string, codec: string, isDefault: boolean) => ({
  id,
  language,
  name,
  codec,
  channels: 2,
  path: `audio/${id}`,
  sourceIndex,
  sourceCodec: codec,
  default: isDefault
})

const METADATA: TitleMetadata = {
  schemaVersion: 1,
  titleId: 't1',
  name: 'Sample',
  durationSeconds: 6,
  standards: ['hls', 'dash'],
  manifests: { hls: 'master.m3u8', dash: 'manifest.mpd' },
  segmentDurationSeconds: 2.002,
  dynamicRange: { source: 'sdr', output: 'sdr' },
  source: { path: 's.mkv', sizeBytes: 1, width: 1920, height: 800, fps: 23.976, codec: 'h264', bitrate: null },
  renditions: [{ label: '720p', width: 1280, height: 534, bitrate: 1, maxBitrate: 1, codec: 'h264', path: 'video/720p' }],
  audioTracks: [
    audioTrack('1_es_aac', 1, 'es', 'Español', 'aac', true),
    audioTrack('2_en_aac', 2, 'en', 'English', 'aac', false),
    audioTrack('3_fr_ac3', 3, 'fr', 'Français', 'ac3', false),
    audioTrack('3_fr_aac', 3, 'fr', 'Français', 'aac', false)
  ],
  subtitleTracks: [
    { id: '4_es', language: 'es', name: 'Español', format: 'vtt', forced: false, path: 'subs/4_es', sourceIndex: 4, sourceFormat: 'subrip', default: false },
    { id: '5_en', language: 'en', name: 'Forced', format: 'vtt', forced: true, path: 'subs/5_en', sourceIndex: 5, sourceFormat: 'ass', default: false }
  ],
  updatedAt: '2026-09-29T00:00:00.000Z'
}

const OVERRIDES = {
  audio: [
    { sourceIndex: 3, name: 'Francés "doblaje"', default: true },
    { sourceIndex: 2, language: 'en-US' }
  ],
  subtitles: [{ sourceIndex: 4, name: 'Español (CC)', default: true }]
}

const mediaLine = (master: string, uri: string): string => master.split('\n').find((l) => l.includes(`URI="${uri}/playlist.m3u8"`)) ?? ''

describe('labelTracks', () => {
  it('keeps what the source says when nothing overrides it', () => {
    const labelled = labelTracks(METADATA, null)
    expect(labelled.audioTracks.map((t) => [t.id, t.name, t.default])).toEqual([
      ['1_es_aac', 'Español', true],
      ['2_en_aac', 'English', false],
      ['3_fr_ac3', 'Français', false],
      ['3_fr_aac', 'Français', false]
    ])
    expect(labelled.subtitleTracks.every((t) => !t.default)).toBe(true)
    expect(JSON.stringify(labelled)).not.toContain('original')
  })

  it('lets the overrides win, remembering what the source said', () => {
    const labelled = labelTracks(METADATA, OVERRIDES)
    const fr = labelled.audioTracks.filter((t) => t.sourceIndex === 3)
    // Both outputs of the Dolby track (the copy and its AAC companion) take the override
    expect(fr.map((t) => [t.name, t.default])).toEqual([
      ['Francés doblaje', true],
      ['Francés doblaje', true]
    ])
    expect(fr[0]!.original).toEqual({ name: 'Français', language: 'fr', default: false })
    const es = labelled.audioTracks.find((t) => t.id === '1_es_aac')!
    expect(es.default).toBe(false)
    expect(es.original).toEqual({ name: 'Español', language: 'es', default: true })
    expect(labelled.audioTracks.find((t) => t.id === '2_en_aac')!.language).toBe('en-US')
    const sub = labelled.subtitleTracks.find((t) => t.id === '4_es')!
    expect([sub.name, sub.default, sub.forced]).toEqual(['Español (CC)', true, false])
  })

  it('goes back to the source when the overrides are removed', () => {
    const back = labelTracks(labelTracks(METADATA, OVERRIDES), null)
    expect(back.audioTracks).toEqual(METADATA.audioTracks)
    expect(back.subtitleTracks).toEqual(METADATA.subtitleTracks)
  })

  it('never repeats a NAME inside a group, as RFC 8216 requires', () => {
    const twins = labelTracks(METADATA, { audio: [{ sourceIndex: 2, name: 'Español' }] })
    expect(twins.audioTracks.map((t) => t.name)).toEqual(['Español', 'Español 2', 'Français', 'Français'])
  })

  it('keeps one default audio track even when the only default is switched off', () => {
    const labelled = labelTracks(METADATA, { audio: [{ sourceIndex: 1, default: false }] })
    expect(labelled.audioTracks.filter((t) => t.default).map((t) => t.id)).toEqual(['2_en_aac'])
  })
})

describe('labelMaster', () => {
  it('rewrites names and languages and leaves exactly one DEFAULT=YES per group', () => {
    const master = labelMaster(MASTER, labelTracks(METADATA, OVERRIDES))
    expect(mediaLine(master, 'audio/3_fr_aac')).toContain('LANGUAGE="fr",NAME="Francés doblaje",DEFAULT=YES')
    expect(mediaLine(master, 'audio/3_fr_ac3')).toContain('DEFAULT=YES')
    expect(mediaLine(master, 'audio/1_es_aac')).toContain('DEFAULT=NO')
    expect(mediaLine(master, 'audio/2_en_aac')).toContain('LANGUAGE="en-US"')
    expect(mediaLine(master, 'subs/4_es')).toContain('NAME="Español (CC)",DEFAULT=YES,AUTOSELECT=YES')
    expect(mediaLine(master, 'subs/5_en')).toContain('DEFAULT=NO,AUTOSELECT=YES,FORCED=YES')
    expect(master.match(/DEFAULT=YES/g)).toHaveLength(3)
    // Variants untouched
    expect(master).toContain('AUDIO="audio-ac3",SUBTITLES="subs",CLOSED-CAPTIONS=NONE\nvideo/720p/playlist.m3u8')
  })

  it('gives a group the default track is not in the same language, or its first track', () => {
    const master = labelMaster(MASTER, labelTracks(METADATA, null))
    expect(mediaLine(master, 'audio/1_es_aac')).toContain('DEFAULT=YES')
    // No Spanish AC-3: the only track of the group
    expect(mediaLine(master, 'audio/3_fr_ac3')).toContain('DEFAULT=YES')
    expect(mediaLine(master, 'audio/3_fr_aac')).toContain('DEFAULT=NO')
  })

  it('drops FORCED from a subtitle that is no longer forced', () => {
    const master = labelMaster(MASTER, labelTracks(METADATA, { subtitles: [{ sourceIndex: 5, forced: false }] }))
    expect(mediaLine(master, 'subs/5_en')).not.toContain('FORCED')
  })
})

describe('labelMpd', () => {
  it('moves lang, Label and the main role with the labels', () => {
    const mpd = labelMpd(MPD, labelTracks(METADATA, OVERRIDES))
    const set = (dir: string): string => mpd.split('<AdaptationSet').find((s) => s.includes(`"${dir}/`)) ?? ''
    expect(set('audio/3_fr_aac')).toContain('<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>')
    expect(set('audio/3_fr_aac')).toContain('<Label>Francés doblaje</Label>')
    expect(set('audio/1_es_aac')).not.toContain('value="main"')
    expect(set('audio/2_en_aac')).toContain('lang="en-US"')
    expect(set('subs/4_es')).toContain('value="subtitle"')
    expect(set('subs/4_es')).toContain('value="main"')
    expect(set('subs/5_en')).toContain('value="forced-subtitle"')
    expect(set('subs/5_en')).not.toContain('value="main"')
    expect(set('video/720p')).toContain('maxWidth="1280"')
    expect(mpd.match(/<Label>/g)).toHaveLength(6)
  })
})
