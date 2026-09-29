import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import type { TitleMetadata } from './types'

// Shaka Packager can only write manifests for the streams it packages in one run,
// and re-packaging published segments is off the table (rule 4). Incremental jobs
// therefore package the new streams alone and merge the resulting manifests into
// the published ones here.

// ---------------------------------------------------------------- HLS master

const VIDEO_CODEC_PREFIXES = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01', 'dvh1', 'dvhe']

export interface HlsAttribute {
  key: string
  value: string
  quoted: boolean
}

interface HlsMedia {
  attributes: HlsAttribute[]
}

interface HlsVariant {
  attributes: HlsAttribute[]
  uri: string
}

interface HlsMaster {
  header: string[]
  media: HlsMedia[]
  variants: HlsVariant[]
}

export function parseMaster(text: string): HlsMaster {
  const master: HlsMaster = { header: [], media: [], variants: [] }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '') continue
    if (line.startsWith('#EXT-X-MEDIA:')) {
      master.media.push({ attributes: parseAttributes(line.slice('#EXT-X-MEDIA:'.length)) })
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      let uri = ''
      while (++i < lines.length) {
        const next = lines[i]!.trim()
        if (next !== '' && !next.startsWith('#')) {
          uri = next
          break
        }
      }
      master.variants.push({ attributes: parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length)), uri })
    } else {
      master.header.push(line)
    }
  }
  return master
}

export function parseAttributes(text: string): HlsAttribute[] {
  const attributes: HlsAttribute[] = []
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g
  for (const match of text.matchAll(pattern)) {
    const quoted = match[2]!.startsWith('"')
    attributes.push({ key: match[1]!, value: quoted ? match[3]! : match[2]!, quoted })
  }
  return attributes
}

export const attr = (list: HlsAttribute[], key: string): string | undefined => list.find((a) => a.key === key)?.value

export function setAttr(list: HlsAttribute[], key: string, value: string, quoted: boolean): void {
  const existing = list.find((a) => a.key === key)
  if (existing) {
    existing.value = value
  } else {
    list.push({ key, value, quoted })
  }
}

const codecsOf = (list: HlsAttribute[]): string[] => (attr(list, 'CODECS') ?? '').split(',').map((c) => c.trim()).filter(Boolean)
const isVideoCodec = (codec: string): boolean => VIDEO_CODEC_PREFIXES.some((p) => codec.startsWith(p))

export function serializeMaster(master: HlsMaster): string {
  const format = (list: HlsAttribute[]): string => list.map((a) => `${a.key}=${a.quoted ? `"${a.value}"` : a.value}`).join(',')
  const lines = [...master.header, '']
  for (const media of master.media) lines.push(`#EXT-X-MEDIA:${format(media.attributes)}`)
  if (master.media.length > 0) lines.push('')
  for (const variant of master.variants) lines.push(`#EXT-X-STREAM-INF:${format(variant.attributes)}`, variant.uri)
  return lines.join('\n') + '\n'
}

export interface StreamBandwidth {
  peak: number
  average: number
}

// Bits per second of a published media playlist, relative to the title folder
export type BandwidthLookup = (playlistUri: string) => Promise<StreamBandwidth>

// Shaka Packager writes one EXT-X-STREAM-INF per video rendition × audio group, and
// only knows the streams of its own run. The merged master is rebuilt the same way
// from every rendition and group published so far; bandwidths come from the
// segments on disk because the playlists do not carry them.
export async function mergeMasterPlaylists(existingText: string, additionText: string, bandwidthOf: BandwidthLookup): Promise<string> {
  const existing = parseMaster(existingText)
  const addition = parseMaster(additionText)

  for (const line of addition.header) {
    if (!existing.header.includes(line) && !line.startsWith('##')) existing.header.push(line)
  }

  // New renditions join by URI; each group keeps a single DEFAULT
  const sameGroup = (a: HlsMedia, b: HlsMedia): boolean =>
    attr(a.attributes, 'TYPE') === attr(b.attributes, 'TYPE') && attr(a.attributes, 'GROUP-ID') === attr(b.attributes, 'GROUP-ID')
  for (const media of addition.media) {
    const uri = attr(media.attributes, 'URI')
    if (existing.media.some((m) => attr(m.attributes, 'URI') === uri)) continue
    if (existing.media.some((m) => sameGroup(m, media) && attr(m.attributes, 'DEFAULT') === 'YES')) setAttr(media.attributes, 'DEFAULT', 'NO', false)
    existing.media.push(media)
  }

  // Video renditions keep their attributes (first variant seen wins); a run without
  // video yields audio-only variants that only tell which codec their group carries
  const mediaUris = new Set(existing.media.map((m) => attr(m.attributes, 'URI')))
  const renditions = new Map<string, HlsVariant>()
  const groupCodecs = new Map<string, Set<string>>()
  for (const variant of [...existing.variants, ...addition.variants]) {
    const codecs = codecsOf(variant.attributes)
    const group = attr(variant.attributes, 'AUDIO')
    if (group) {
      const set = groupCodecs.get(group) ?? new Set<string>()
      for (const codec of codecs) if (!isVideoCodec(codec)) set.add(codec)
      groupCodecs.set(group, set)
    }
    if (mediaUris.has(variant.uri) || !codecs.some(isVideoCodec)) continue
    if (!renditions.has(variant.uri)) renditions.set(variant.uri, variant)
  }

  const mediaOf = (type: string): HlsMedia[] => existing.media.filter((m) => attr(m.attributes, 'TYPE') === type)
  const audioGroups = [...new Set(mediaOf('AUDIO').map((m) => attr(m.attributes, 'GROUP-ID') ?? ''))]
  const subtitleGroup = mediaOf('SUBTITLES').map((m) => attr(m.attributes, 'GROUP-ID')).find(Boolean)

  const measured = new Map<string, Promise<StreamBandwidth>>()
  const bandwidth = (uri: string): Promise<StreamBandwidth> => {
    if (!measured.has(uri)) measured.set(uri, bandwidthOf(uri))
    return measured.get(uri)!
  }
  // A variant's bandwidth is its video plus the heaviest rendition of the group
  const groupBandwidth = async (group: string): Promise<StreamBandwidth> => {
    const members = mediaOf('AUDIO').filter((m) => attr(m.attributes, 'GROUP-ID') === group)
    const values = await Promise.all(members.map((m) => bandwidth(attr(m.attributes, 'URI') ?? '')))
    return { peak: Math.max(0, ...values.map((v) => v.peak)), average: Math.max(0, ...values.map((v) => v.average)) }
  }

  const variants: HlsVariant[] = []
  for (const [uri, template] of renditions) {
    const video = await bandwidth(uri)
    const videoCodecs = codecsOf(template.attributes).filter(isVideoCodec)
    for (const group of audioGroups.length > 0 ? audioGroups : [undefined]) {
      const audio = group === undefined ? { peak: 0, average: 0 } : await groupBandwidth(group)
      const attributes = template.attributes.map((a) => ({ ...a }))
      setAttr(attributes, 'BANDWIDTH', String(video.peak + audio.peak), false)
      setAttr(attributes, 'AVERAGE-BANDWIDTH', String(video.average + audio.average), false)
      setAttr(attributes, 'CODECS', [...videoCodecs, ...(group === undefined ? [] : groupCodecs.get(group) ?? [])].join(','), true)
      if (group !== undefined) setAttr(attributes, 'AUDIO', group, true)
      if (subtitleGroup) setAttr(attributes, 'SUBTITLES', subtitleGroup, true)
      variants.push({ attributes, uri })
    }
  }
  existing.variants = variants

  return serializeMaster(existing)
}

// Peak and average bitrate of a media playlist from its segments, the way the
// packager computes them for the master (peak = fastest segment; the short tail
// segment is left out of the peak so it cannot spike it)
export async function measureBandwidth(playlistFile: string): Promise<StreamBandwidth> {
  const dir = dirname(playlistFile)
  const segments: { seconds: number; bytes: number }[] = []
  let seconds: number | null = null
  for (const raw of (await readFile(playlistFile, 'utf8')).split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) {
      seconds = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (seconds !== null && line !== '' && !line.startsWith('#')) {
      segments.push({ seconds, bytes: (await stat(join(dir, line))).size })
      seconds = null
    }
  }
  if (segments.length === 0) throw new Error(`La playlist no lista segmentos: ${playlistFile}`)

  const bitrate = (s: { seconds: number; bytes: number }): number => (s.bytes * 8) / s.seconds
  const typical = [...segments].sort((a, b) => a.seconds - b.seconds)[Math.floor(segments.length / 2)]!.seconds
  const full = segments.filter((s) => s.seconds >= typical / 2)
  const totalBytes = segments.reduce((sum, s) => sum + s.bytes, 0)
  const totalSeconds = segments.reduce((sum, s) => sum + s.seconds, 0)
  return {
    peak: Math.round(Math.max(...(full.length > 0 ? full : segments).map(bitrate))),
    average: Math.round((totalBytes * 8) / totalSeconds)
  }
}

// ---------------------------------------------------------------- DASH MPD

export type XmlNode = Record<string, unknown> & { ':@'?: Record<string, string> }

// trimValues drops the indentation between tags: kept, the builder indents again around
// it and every rewrite of the manifest adds blank lines
export const xmlOptions = { preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true }

export function children(node: XmlNode, tag: string): XmlNode[] {
  return (node[tag] as XmlNode[] | undefined) ?? []
}

export function findChild(list: XmlNode[], tag: string): XmlNode | undefined {
  return list.find((n) => tag in n)
}

function maxId(nodes: XmlNode[], tag: string): number {
  let max = -1
  const visit = (list: XmlNode[]): void => {
    for (const node of list) {
      if (tag in node) max = Math.max(max, Number(node[':@']?.['@_id'] ?? -1))
      for (const key of Object.keys(node)) if (key !== ':@' && Array.isArray(node[key])) visit(node[key] as XmlNode[])
    }
  }
  visit(nodes)
  return max
}

export function mergeMpds(existingText: string, additionText: string): string {
  const parser = new XMLParser(xmlOptions)
  const existing = parser.parse(existingText) as XmlNode[]
  const addition = parser.parse(additionText) as XmlNode[]

  const mpd = findChild(existing, 'MPD')
  const period = mpd && findChild(children(mpd, 'MPD'), 'Period')
  const additionMpd = findChild(addition, 'MPD')
  const additionPeriod = additionMpd && findChild(children(additionMpd, 'MPD'), 'Period')
  if (!period || !additionPeriod) throw new Error('MPD sin Period: no se puede fusionar')

  const periodChildren = children(period, 'Period')
  let nextRepresentationId = maxId(existing, 'Representation') + 1
  let nextSetId = maxId(existing, 'AdaptationSet') + 1

  for (const set of children(additionPeriod, 'Period')) {
    if (!('AdaptationSet' in set)) continue
    const attributes = set[':@'] ?? {}
    const representations = children(set, 'AdaptationSet').filter((n) => 'Representation' in n)
    for (const rep of representations) {
      rep[':@'] = { ...rep[':@'], '@_id': String(nextRepresentationId++) }
    }

    const target =
      attributes['@_contentType'] === 'video'
        ? periodChildren.find((n) => 'AdaptationSet' in n && n[':@']?.['@_contentType'] === 'video')
        : undefined

    if (target) {
      // New video quality: same adaptation set, wider limits
      const targetAttributes = target[':@'] ?? {}
      const targetChildren = children(target, 'AdaptationSet')
      targetChildren.push(...representations)
      for (const key of ['@_maxWidth', '@_maxHeight'] as const) {
        const value = Math.max(Number(targetAttributes[key] ?? 0), Number(attributes[key] ?? 0))
        if (value > 0) targetAttributes[key] = String(value)
      }
      target[':@'] = targetAttributes
    } else {
      set[':@'] = { ...attributes, '@_id': String(nextSetId++) }
      periodChildren.push(set)
    }
  }

  return new XMLBuilder({ ...xmlOptions, format: true, indentBy: '  ', suppressEmptyNode: true }).build(existing) as string
}

// ---------------------------------------------------------------- metadata.json

export function mergeMetadata(existing: TitleMetadata, addition: TitleMetadata): TitleMetadata {
  const byKey = <T>(list: T[], extra: T[], key: (item: T) => string): T[] => {
    const seen = new Set(list.map(key))
    return [...list, ...extra.filter((item) => !seen.has(key(item)))]
  }
  // Tracks added later never take over as the default: the published title keeps its own
  return {
    ...existing,
    renditions: byKey(existing.renditions, addition.renditions, (r) => r.label),
    audioTracks: byKey(existing.audioTracks, addition.audioTracks.map((a) => ({ ...a, default: false })), (a) => a.id),
    subtitleTracks: byKey(existing.subtitleTracks, addition.subtitleTracks.map((s) => ({ ...s, default: false })), (s) => s.id),
    updatedAt: new Date().toISOString()
  }
}

// ---------------------------------------------------------------- atomic replace

// Readers see the old file or the new one, never a partial write. On Windows the
// rename fails while another process holds the file open, hence the retries.
export async function replaceFileAtomic(target: string, content: string, attempts = 8): Promise<void> {
  const tmp = `${target}.tmp`
  await writeFile(tmp, content, 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error
      await sleep(50 * attempt)
    }
  }
}
