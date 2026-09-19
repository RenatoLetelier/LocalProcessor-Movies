import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DB_FILE_NAME } from '@server/db'

// The app was called LocalProcessor up to 1.0.0, so its data folder sits next to
// ours under the old name. It is adopted once: the first time the renamed app
// starts without a database of its own.
export const LEGACY_APP_NAME = 'LocalProcessor'

// SQLite journal files must travel with the database or the copy may miss committed rows
const DB_SUFFIXES = ['', '-wal', '-shm']

export function adoptLegacyDataDir(dataDir: string, legacyDir = join(dirname(dataDir), LEGACY_APP_NAME)): boolean {
  const target = join(dataDir, DB_FILE_NAME)
  const source = join(legacyDir, DB_FILE_NAME)
  if (existsSync(target) || !existsSync(source)) return false

  mkdirSync(dataDir, { recursive: true })
  for (const suffix of DB_SUFFIXES) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix)
  }
  return true
}
