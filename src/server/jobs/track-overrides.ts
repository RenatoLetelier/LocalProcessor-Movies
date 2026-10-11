import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TrackOverride, TrackOverrides } from '@shared/model'
import { cleanLabelText, applyTrackLabels } from '@pipeline/labels'
import { toBcp47 } from '@pipeline/lang'
import { METADATA_FILE } from '@pipeline/layout'
import type { TitleMetadata } from '@pipeline/types'
import type { Repositories } from '../db/repositories'
import { badRequest } from '../errors'

const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/
const MAX_NAME_LENGTH = 120

// Validates and normalises the names, languages and default tracks a consumer sends
// (languages to BCP-47, names without what a playlist cannot quote). Throws 400 with
// every problem at once. `known` lists the source indexes the title actually has.
export function parseTrackOverrides(value: unknown, known?: { audio: number[]; subtitles: number[] }): TrackOverrides | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('tracks debe ser un objeto { audio?, subtitles? }')
  const body = value as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(body)) if (key !== 'audio' && key !== 'subtitles') problems.push(`tracks.${key}: campo desconocido`)

  const parseList = (field: 'audio' | 'subtitles'): TrackOverride[] => {
    const list = body[field]
    if (list === undefined) return []
    if (!Array.isArray(list)) {
      problems.push(`tracks.${field}: debe ser una lista`)
      return []
    }
    const result: TrackOverride[] = []
    list.forEach((raw: unknown, i) => {
      const at = `tracks.${field}[${i}]`
      if (typeof raw !== 'object' || raw === null) return void problems.push(`${at}: debe ser un objeto`)
      const entry = raw as Record<string, unknown>
      for (const key of Object.keys(entry)) {
        if (!['sourceIndex', 'name', 'language', 'default', 'forced', 'excluded'].includes(key)) problems.push(`${at}.${key}: campo desconocido`)
      }
      if (!Number.isInteger(entry.sourceIndex)) return void problems.push(`${at}.sourceIndex: debe ser un entero`)
      const sourceIndex = entry.sourceIndex as number
      const excluded = entry.excluded === true
      if (entry.excluded !== undefined && typeof entry.excluded !== 'boolean') problems.push(`${at}.excluded: debe ser true o false`)
      if (excluded && entry.default === true) problems.push(`${at}: una pista quitada no puede ser la predeterminada`)
      const available = known?.[field]
      // A track dropped earlier no longer has a row: repeating its exclusion is harmless
      if (available && !available.includes(sourceIndex) && !excluded) problems.push(`${at}.sourceIndex: el título no tiene la pista ${sourceIndex}`)
      if (result.some((o) => o.sourceIndex === sourceIndex)) problems.push(`${at}.sourceIndex: la pista ${sourceIndex} está repetida`)

      const override: TrackOverride = { sourceIndex }
      if (entry.name !== undefined && entry.name !== null) {
        if (typeof entry.name !== 'string') problems.push(`${at}.name: debe ser texto`)
        else {
          const name = cleanLabelText(entry.name)
          if (name.length > MAX_NAME_LENGTH) problems.push(`${at}.name: máximo ${MAX_NAME_LENGTH} caracteres`)
          else if (name) override.name = name
        }
      }
      if (entry.language !== undefined && entry.language !== null) {
        const language = typeof entry.language === 'string' ? toBcp47(entry.language) : ''
        if (!LANGUAGE_TAG.test(language)) problems.push(`${at}.language: no es una etiqueta de idioma BCP-47 (${String(entry.language)})`)
        else override.language = language
      }
      if (entry.default !== undefined) {
        if (typeof entry.default !== 'boolean') problems.push(`${at}.default: debe ser true o false`)
        else override.default = entry.default
      }
      if (entry.forced !== undefined) {
        if (field === 'audio') problems.push(`${at}.forced: solo existe para subtítulos`)
        else if (typeof entry.forced !== 'boolean') problems.push(`${at}.forced: debe ser true o false`)
        else override.forced = entry.forced
      }
      if (excluded) override.excluded = true
      result.push(override)
    })
    if (result.filter((o) => o.default === true).length > 1) problems.push(`tracks.${field}: solo una pista puede ser la predeterminada`)
    return result
  }

  const audio = parseList('audio')
  const subtitles = parseList('subtitles')
  if (known && known.audio.length > 0 && known.audio.every((index) => audio.some((o) => o.sourceIndex === index && o.excluded))) {
    problems.push('tracks.audio: tiene que quedar al menos una pista de audio')
  }
  if (problems.length > 0) throw badRequest(`Pistas inválidas: ${problems.join('; ')}`, { problems })
  if (audio.length + subtitles.length === 0) return null
  return { ...(audio.length ? { audio } : {}), ...(subtitles.length ? { subtitles } : {}) }
}

// Rows of the tracks the overrides drop, once their folders are gone: the title stops
// listing what it no longer publishes. A Dolby copy and its AAC companion share the index.
export function forgetExcluded(repos: Pick<Repositories, 'audioTracks' | 'subtitleTracks'>, titleId: string, overrides: TrackOverrides | null): void {
  const dropped = (list: TrackOverride[] | undefined): Set<number> => new Set((list ?? []).filter((o) => o.excluded).map((o) => o.sourceIndex))
  const audio = dropped(overrides?.audio)
  const subtitles = dropped(overrides?.subtitles)
  for (const row of repos.audioTracks.listByTitle(titleId)) if (audio.has(row.source_index)) repos.audioTracks.remove(row.id)
  for (const row of repos.subtitleTracks.listByTitle(titleId)) if (subtitles.has(row.source_index)) repos.subtitleTracks.remove(row.id)
}

const chains = new Map<string, Promise<unknown>>()

// Relabels a published folder, one run at a time per title: a PUT and the end of a job
// can land together, and each must see the files the previous one left. Resolves to
// null when the folder is not published yet (the job that publishes it applies them).
export function relabelTitle(titleId: string, folder: string, overrides: TrackOverrides | null): Promise<TitleMetadata | null> {
  const previous = chains.get(titleId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => (existsSync(join(folder, METADATA_FILE)) ? applyTrackLabels(folder, overrides) : null))
  chains.set(titleId, next)
  void next
    .finally(() => {
      if (chains.get(titleId) === next) chains.delete(titleId)
    })
    .catch(() => undefined)
  return next
}
