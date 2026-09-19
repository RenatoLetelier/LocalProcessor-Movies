import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_FILE_NAME, openDatabase } from '@server/db'
import { LEGACY_APP_NAME, adoptLegacyDataDir } from '../data-dir'

let root: string
let dataDir: string
let legacyDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-data-dir-'))
  dataDir = join(root, 'LocalProcessor-Movies')
  legacyDir = join(root, LEGACY_APP_NAME)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('adoptLegacyDataDir', () => {
  it('copies the LocalProcessor database the first time the renamed app starts', () => {
    const legacy = openDatabase(join(legacyDir, DB_FILE_NAME))
    legacy.repos.settings.updateConfig({ outputFolder: root })
    legacy.repos.titles.create({ id: 'a1', name: 'Película', source_path: join(root, 'p.mkv'), output_folder: join(root, 'a1') })
    legacy.close()

    expect(adoptLegacyDataDir(dataDir)).toBe(true)

    const adopted = openDatabase(join(dataDir, DB_FILE_NAME))
    expect(adopted.repos.settings.getConfig().outputFolder).toBe(root)
    expect(adopted.repos.titles.list().map((t) => t.name)).toEqual(['Película'])
    adopted.close()
    // The old folder is left untouched for the previous version
    expect(existsSync(join(legacyDir, DB_FILE_NAME))).toBe(true)
  })

  it('brings the journal files along when they exist', () => {
    mkdirSync(legacyDir, { recursive: true })
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(join(legacyDir, DB_FILE_NAME + suffix), `x${suffix}`)

    adoptLegacyDataDir(dataDir)

    for (const suffix of ['', '-wal', '-shm']) expect(readFileSync(join(dataDir, DB_FILE_NAME + suffix), 'utf8')).toBe(`x${suffix}`)
  })

  it('does nothing without a legacy database', () => {
    expect(adoptLegacyDataDir(dataDir)).toBe(false)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('never overwrites a database the renamed app already has', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, DB_FILE_NAME), 'old')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, DB_FILE_NAME), 'current')

    expect(adoptLegacyDataDir(dataDir)).toBe(false)
    expect(readFileSync(join(dataDir, DB_FILE_NAME), 'utf8')).toBe('current')
  })
})
