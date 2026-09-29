import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import type { TrackOverride, TrackOverrides } from '@shared/model'
import { METADATA_FILE, MEDIA_PLAYLIST, SUBTITLE_GROUP_ID, audioGroupId } from './layout'
import { attr, children, parseMaster, replaceFileAtomic, serializeMaster, setAttr, xmlOptions, type XmlNode } from './manifests'
import type { MetadataAudioTrack, MetadataSubtitleTrack, TitleMetadata, TrackLabel } from './types'

// Names, languages and default tracks live in three places that must agree: the HLS
// master, the DASH manifest and metadata.json. Shaka Packager writes them from the
// source, marks defaults by language (every group, and every same-language track in
// it) and happily repeats a NAME inside a group, which RFC 8216 forbids. This module
// rewrites all three from one decision, after packaging and whenever a consumer sends
// its own names (a catalog), without touching a single segment.

type Track = MetadataAudioTrack | MetadataSubtitleTrack

const ROLE_SCHEME = 'urn:mpeg:dash:role:2011'
const MANAGED_ROLES = new Set(['main', 'subtitle', 'forced-subtitle'])

// Quoted strings in a playlist cannot hold a double quote or a line break
export function cleanLabelText(text: string): string {
  return text.replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// What the source said: kept under `original` once an override replaced it
function baseOf(track: Track): TrackLabel {
  if (track.original) return track.original
  return { name: track.name, language: track.language, default: track.default ?? false, ...('forced' in track ? { forced: track.forced } : {}) }
}

const sameLabel = (a: TrackLabel, b: TrackLabel): boolean =>
  a.name === b.name && a.language === b.language && a.default === b.default && (a.forced ?? false) === (b.forced ?? false)

interface Resolved<T extends Track> {
  track: T
  base: TrackLabel
  label: TrackLabel
  override: TrackOverride | undefined
}

function resolve<T extends Track>(tracks: T[], overrides: TrackOverride[], subtitles: boolean): Resolved<T>[] {
  return tracks.map((track) => {
    const base = baseOf(track)
    const override = overrides.find((o) => o.sourceIndex === track.sourceIndex)
    const name = override?.name ? cleanLabelText(override.name) : ''
    const language = override?.language ? cleanLabelText(override.language) : ''
    const label: TrackLabel = {
      name: name || base.name,
      language: language || base.language,
      default: override?.default ?? base.default,
      ...(subtitles ? { forced: override?.forced ?? base.forced ?? false } : {})
    }
    return { track, base, label, override }
  })
}

// One source track is the default, with every output it has (a Dolby copy and its AAC
// companion share the index). An explicit override wins over what the source flags.
function pickDefault(resolved: Resolved<Track>[], fallbackToFirst: boolean): number | undefined {
  const explicit = resolved.find((r) => r.override?.default === true)
  if (explicit) return explicit.track.sourceIndex
  const flagged = resolved.find((r) => r.label.default)
  if (flagged) return flagged.track.sourceIndex
  if (!fallbackToFirst) return undefined
  return (resolved.find((r) => r.override?.default !== false) ?? resolved[0])?.track.sourceIndex
}

// NAME must be unique inside an HLS group: a second "Español" becomes "Español 2"
function dedupeNames(resolved: Resolved<Track>[], groupOf: (track: Track) => string): void {
  const used = new Map<string, Set<string>>()
  for (const r of resolved) {
    const names = used.get(groupOf(r.track)) ?? new Set<string>()
    let candidate = r.label.name
    for (let n = 2; names.has(candidate); n++) candidate = `${r.label.name} ${n}`
    names.add(candidate)
    used.set(groupOf(r.track), names)
    r.label.name = candidate
  }
}

function finish<T extends Track>(r: Resolved<T>): T {
  const { original: _previous, ...track } = r.track
  const labelled = { ...track, name: r.label.name, language: r.label.language, default: r.label.default } as T
  if ('forced' in labelled) (labelled as MetadataSubtitleTrack).forced = r.label.forced ?? false
  return sameLabel(r.base, r.label) ? labelled : { ...labelled, original: r.base }
}

// Final names, languages, default and forced flags of every track: the source's, with
// the overrides on top. Pure: metadata in, metadata out.
export function labelTracks(metadata: TitleMetadata, overrides: TrackOverrides | null | undefined): TitleMetadata {
  const audio = resolve(metadata.audioTracks, overrides?.audio ?? [], false)
  const subtitles = resolve(metadata.subtitleTracks, overrides?.subtitles ?? [], true)

  const defaultAudio = pickDefault(audio, true)
  for (const r of audio) r.label.default = r.track.sourceIndex === defaultAudio
  // Subtitles stay off unless someone asked for one
  const defaultSubtitle = pickDefault(subtitles, false)
  for (const r of subtitles) r.label.default = r.track.sourceIndex === defaultSubtitle

  dedupeNames(audio, (t) => audioGroupId({ outputCodec: (t as MetadataAudioTrack).codec }))
  dedupeNames(subtitles, () => SUBTITLE_GROUP_ID)

  return { ...metadata, audioTracks: audio.map(finish), subtitleTracks: subtitles.map(finish) }
}

// ---------------------------------------------------------------- HLS master

export function labelMaster(text: string, metadata: TitleMetadata): string {
  const master = parseMaster(text)
  const byUri = new Map<string, Track>()
  for (const track of [...metadata.audioTracks, ...metadata.subtitleTracks]) byUri.set(`${track.path}/${MEDIA_PLAYLIST}`, track)

  for (const media of master.media) {
    const track = byUri.get(attr(media.attributes, 'URI') ?? '')
    if (!track) continue
    setAttr(media.attributes, 'LANGUAGE', track.language, true)
    setAttr(media.attributes, 'NAME', track.name, true)
    setAttr(media.attributes, 'AUTOSELECT', 'YES', false)
    if (attr(media.attributes, 'TYPE') === 'SUBTITLES') {
      media.attributes = media.attributes.filter((a) => a.key !== 'FORCED')
      if ((track as MetadataSubtitleTrack).forced) setAttr(media.attributes, 'FORCED', 'YES', false)
    }
  }

  // Exactly one DEFAULT=YES per audio group (the default track, or in a group it is not
  // part of, the same language or the first); in the subtitle group, only one asked for
  const defaultLanguage = metadata.audioTracks.find((t) => t.default)?.language
  const groups = new Map<string, typeof master.media>()
  for (const media of master.media) {
    const key = `${attr(media.attributes, 'TYPE')}/${attr(media.attributes, 'GROUP-ID')}`
    groups.set(key, [...(groups.get(key) ?? []), media])
  }
  for (const [key, members] of groups) {
    const isDefault = (m: (typeof members)[number]): boolean => byUri.get(attr(m.attributes, 'URI') ?? '')?.default === true
    const pick = key.startsWith('AUDIO/')
      ? (members.find(isDefault) ?? members.find((m) => attr(m.attributes, 'LANGUAGE') === defaultLanguage) ?? members[0])
      : members.find(isDefault)
    for (const member of members) setAttr(member.attributes, 'DEFAULT', member === pick ? 'YES' : 'NO', false)
  }

  return serializeMaster(master)
}

// ---------------------------------------------------------------- DASH manifest

// The folder of the first representation of an adaptation set (audio/1_es_aac)
function adaptationSetPath(set: XmlNode[]): string | undefined {
  for (const representation of set.filter((n) => 'Representation' in n)) {
    for (const template of children(representation, 'Representation').filter((n) => 'SegmentTemplate' in n)) {
      const uri = template[':@']?.['@_initialization'] ?? template[':@']?.['@_media']
      if (uri) return uri.slice(0, uri.lastIndexOf('/'))
    }
  }
  return undefined
}

const roleNode = (value: string): XmlNode => ({ Role: [], ':@': { '@_schemeIdUri': ROLE_SCHEME, '@_value': value } })

export function labelMpd(text: string, metadata: TitleMetadata): string {
  const document = new XMLParser(xmlOptions).parse(text) as XmlNode[]
  const byPath = new Map<string, { track: Track; text: boolean }>()
  for (const track of metadata.audioTracks) byPath.set(track.path, { track, text: false })
  for (const track of metadata.subtitleTracks) byPath.set(track.path, { track, text: true })

  const visit = (nodes: XmlNode[]): void => {
    for (const node of nodes) {
      if ('AdaptationSet' in node) {
        const set = children(node, 'AdaptationSet')
        const match = byPath.get(adaptationSetPath(set) ?? '')
        if (!match) continue
        const { track, text: isText } = match
        node[':@'] = { ...node[':@'], '@_lang': track.language }
        const roles: XmlNode[] = []
        if (isText) roles.push(roleNode((track as MetadataSubtitleTrack).forced ? 'forced-subtitle' : 'subtitle'))
        if (track.default) roles.push(roleNode('main'))
        const rest = set.filter((n) => !('Label' in n) && !('Role' in n && n[':@']?.['@_schemeIdUri'] === ROLE_SCHEME && MANAGED_ROLES.has(n[':@']?.['@_value'] ?? '')))
        node.AdaptationSet = [...roles, { Label: [{ '#text': track.name }] }, ...rest]
        continue
      }
      for (const key of Object.keys(node)) if (key !== ':@' && Array.isArray(node[key])) visit(node[key] as XmlNode[])
    }
  }
  visit(document)

  return new XMLBuilder({ ...xmlOptions, format: true, indentBy: '  ', suppressEmptyNode: true }).build(document) as string
}

// ---------------------------------------------------------------- on disk

// Relabels a packaged title folder in place. Every file is replaced atomically, so a
// player reads the previous version or the new one, never half of each.
export async function applyTrackLabels(titleDir: string, overrides: TrackOverrides | null | undefined): Promise<TitleMetadata> {
  const current = JSON.parse(await readFile(join(titleDir, METADATA_FILE), 'utf8')) as TitleMetadata
  const metadata = { ...labelTracks(current, overrides), updatedAt: new Date().toISOString() }
  if (metadata.manifests.hls) {
    const file = join(titleDir, metadata.manifests.hls)
    await replaceFileAtomic(file, labelMaster(await readFile(file, 'utf8'), metadata))
  }
  if (metadata.manifests.dash) {
    const file = join(titleDir, metadata.manifests.dash)
    await replaceFileAtomic(file, labelMpd(await readFile(file, 'utf8'), metadata))
  }
  await replaceFileAtomic(join(titleDir, METADATA_FILE), JSON.stringify(metadata, null, 2) + '\n')
  return metadata
}
