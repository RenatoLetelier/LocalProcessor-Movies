import type { DatabaseSync } from 'node:sqlite'
import type { Title, TitleStatus } from '@shared/model'
import { newId, now, updateColumns } from './common'

export interface NewTitle {
  id?: string
  name: string
  source_path?: string | null
  source_managed?: boolean
  output_folder: string
  status?: TitleStatus
}

export type TitlePatch = Partial<Omit<Title, 'id' | 'created_at' | 'updated_at'>>

const MUTABLE_COLUMNS = [
  'name',
  'source_path',
  'source_hash',
  'source_width',
  'source_height',
  'source_video_bitrate',
  'source_fps',
  'source_video_codec',
  'source_hdr',
  'duration_seconds',
  'output_folder',
  'track_overrides',
  'status',
  'error',
  'updated_at'
] as const

export interface TitlesRepository {
  create(input: NewTitle): Title
  get(id: string): Title | undefined
  findBySourcePath(sourcePath: string): Title | undefined
  list(): Title[]
  update(id: string, patch: TitlePatch): Title | undefined
  remove(id: string): boolean
}

export function createTitlesRepository(db: DatabaseSync): TitlesRepository {
  const insert = db.prepare(`
    INSERT INTO titles (id, name, source_path, source_managed, output_folder, status, created_at, updated_at)
    VALUES (@id, @name, @source_path, @source_managed, @output_folder, @status, @created_at, @updated_at)
  `)
  const selectById = db.prepare('SELECT * FROM titles WHERE id = ?')
  const selectBySource = db.prepare('SELECT * FROM titles WHERE source_path = ? ORDER BY created_at DESC LIMIT 1')
  const selectAll = db.prepare('SELECT * FROM titles ORDER BY created_at DESC')
  const deleteById = db.prepare('DELETE FROM titles WHERE id = ?')

  // SQLite has no boolean type: source_managed travels as 0/1, and the overrides as JSON
  const fromRow = (row: unknown): Title | undefined => {
    if (!row) return undefined
    const raw = row as Omit<Title, 'source_managed' | 'track_overrides'> & { source_managed: number; track_overrides: string | null }
    return { ...raw, source_managed: raw.source_managed === 1, track_overrides: raw.track_overrides ? (JSON.parse(raw.track_overrides) as Title['track_overrides']) : null }
  }
  const get = (id: string): Title | undefined => fromRow(selectById.get(id))

  return {
    create(input) {
      const id = input.id ?? newId()
      const timestamp = now()
      insert.run({
        id,
        name: input.name,
        source_path: input.source_path ?? null,
        source_managed: input.source_managed ? 1 : 0,
        output_folder: input.output_folder,
        status: input.status ?? 'queued',
        created_at: timestamp,
        updated_at: timestamp
      })
      return get(id)!
    },
    get,
    findBySourcePath: (sourcePath) => fromRow(selectBySource.get(sourcePath)),
    list: () => selectAll.all().map((row) => fromRow(row)!),
    update(id, patch) {
      updateColumns(db, 'titles', id, { ...patch, updated_at: now() }, MUTABLE_COLUMNS)
      return get(id)
    },
    remove: (id) => deleteById.run(id).changes > 0
  }
}
