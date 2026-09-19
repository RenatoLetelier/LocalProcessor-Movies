// Downloads the third-party binaries the app bundles into resources/bin/<platform>-<arch>/
// (ffmpeg, ffprobe, Shaka Packager) and their license texts into resources/licenses/.
// Both folders are gitignored; electron-builder copies them as extraResources.
//
//   npm run fetch-bins            → binaries for this machine + licenses
//   npm run fetch-bins -- --force → re-download even if the versions already match
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const SHAKA_VERSION = 'v3.9.3'

interface FfmpegSource {
  version: string
  license: string
  // Archives to download; every executable found under a bin/ folder (or at the root) is collected
  archives: string[]
}

// GPL builds (libx264): the notices in resources/licenses/ travel with the installer
const FFMPEG: Record<string, FfmpegSource> = {
  'win32-x64': {
    version: '8.1.2',
    license: 'GPL-3.0 (gyan.dev essentials build)',
    archives: ['https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip']
  },
  'linux-x64': {
    version: 'n8.1 (latest patch)',
    license: 'GPL-3.0 (BtbN static build)',
    archives: ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz']
  },
  'linux-arm64': {
    version: 'n8.1 (latest patch)',
    license: 'GPL-3.0 (BtbN static build)',
    archives: ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linuxarm64-gpl-8.1.tar.xz']
  },
  // evermeet.cx ships x86_64 only; Apple Silicon runs it through Rosetta 2
  'darwin-x64': {
    version: '7.1.1',
    license: 'GPL-3.0 (evermeet.cx build)',
    archives: ['https://evermeet.cx/ffmpeg/ffmpeg-7.1.1.zip', 'https://evermeet.cx/ffmpeg/ffprobe-7.1.1.zip']
  },
  'darwin-arm64': {
    version: '7.1.1 (x86_64 via Rosetta 2)',
    license: 'GPL-3.0 (evermeet.cx build)',
    archives: ['https://evermeet.cx/ffmpeg/ffmpeg-7.1.1.zip', 'https://evermeet.cx/ffmpeg/ffprobe-7.1.1.zip']
  }
}

const SHAKA_ASSETS: Record<string, string> = {
  'win32-x64': 'packager-win-x64.exe',
  'linux-x64': 'packager-linux-x64',
  'linux-arm64': 'packager-linux-arm64',
  'darwin-x64': 'packager-osx-x64',
  'darwin-arm64': 'packager-osx-arm64'
}

const LICENSES: { file: string; url: string }[] = [
  { file: 'ffmpeg-LICENSE.md', url: 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.1/LICENSE.md' },
  { file: 'ffmpeg-GPL-3.0.txt', url: 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.1/COPYING.GPLv3' },
  { file: 'x264-GPL-2.0.txt', url: 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.1/COPYING.GPLv2' },
  { file: 'shaka-packager-LICENSE.txt', url: `https://raw.githubusercontent.com/shaka-project/shaka-packager/${SHAKA_VERSION}/LICENSE` }
]

const force = process.argv.includes('--force')
const target = `${process.platform}-${process.arch}`
const exe = process.platform === 'win32' ? '.exe' : ''
const resources = resolve(__dirname, '..', 'resources')
const binDir = join(resources, 'bin', target)
const licenseDir = join(resources, 'licenses')

async function main(): Promise<void> {
  mkdirSync(binDir, { recursive: true })
  mkdirSync(licenseDir, { recursive: true })

  await fetchShaka()
  await fetchFfmpeg()
  await fetchLicenses()
  writeManifest()
}

async function fetchShaka(): Promise<void> {
  const asset = SHAKA_ASSETS[target]
  if (!asset) throw new Error(`No hay binario de Shaka Packager para ${target}`)
  const path = join(binDir, `packager${exe}`)
  if (!force && versionOf(path, ['--version'])?.includes(SHAKA_VERSION)) {
    console.log(`Shaka Packager ${SHAKA_VERSION} ya está en ${path}`)
    return
  }
  await download(`https://github.com/shaka-project/shaka-packager/releases/download/${SHAKA_VERSION}/${asset}`, path)
  makeExecutable(path)
  console.log(`Shaka Packager: ${versionOf(path, ['--version'])}`)
}

async function fetchFfmpeg(): Promise<void> {
  const source = FFMPEG[target]
  if (!source) throw new Error(`No hay build de ffmpeg definido para ${target}`)
  const ffmpeg = join(binDir, `ffmpeg${exe}`)
  const ffprobe = join(binDir, `ffprobe${exe}`)
  const marker = join(binDir, 'ffmpeg.source')
  if (!force && existsSync(ffmpeg) && existsSync(ffprobe) && existsSync(marker) && readFileSync(marker, 'utf8') === source.archives.join('\n')) {
    console.log(`ffmpeg ${source.version} ya está en ${binDir}`)
    return
  }

  const work = mkdtempSync(join(tmpdir(), 'lp-ffmpeg-'))
  try {
    for (const url of source.archives) {
      const archive = join(work, url.split('/').pop()!)
      await download(url, archive)
      await verifyChecksum(url, archive)
      // bsdtar (Windows, macOS) opens zips; GNU tar handles the Linux .tar.xz
      execFileSync(tarBinary(), ['-xf', archive, '-C', work], { stdio: 'inherit' })
    }
    for (const name of ['ffmpeg', 'ffprobe']) {
      const found = findExecutable(work, `${name}${exe}`)
      if (!found) throw new Error(`No se encontró ${name}${exe} dentro de los archivos descargados`)
      copyFileSync(found, join(binDir, `${name}${exe}`))
      makeExecutable(join(binDir, `${name}${exe}`))
    }
    writeFileSync(marker, source.archives.join('\n'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  console.log(`ffmpeg: ${versionOf(ffmpeg, ['-version'])}`)
  console.log(`ffprobe: ${versionOf(ffprobe, ['-version'])}`)
}

async function fetchLicenses(): Promise<void> {
  for (const { file, url } of LICENSES) {
    const path = join(licenseDir, file)
    if (!force && existsSync(path)) continue
    await download(url, path)
  }
  console.log(`Licencias en ${licenseDir}`)
}

// What ended up bundled, for the installer and for humans
function writeManifest(): void {
  const source = FFMPEG[target]!
  const lines = [
    'Componentes de terceros incluidos en LocalProcessor-Movies',
    '',
    `ffmpeg / ffprobe ${source.version} — ${source.license}`,
    ...source.archives.map((u) => `  ${u}`),
    '  Licencias: ffmpeg-LICENSE.md, ffmpeg-GPL-3.0.txt, x264-GPL-2.0.txt',
    '',
    `Shaka Packager ${SHAKA_VERSION} — BSD-3-Clause`,
    `  https://github.com/shaka-project/shaka-packager/releases/tag/${SHAKA_VERSION}`,
    '  Licencia: shaka-packager-LICENSE.txt',
    ''
  ]
  writeFileSync(join(licenseDir, 'THIRD-PARTY.txt'), lines.join('\n'))
}

async function download(url: string, destination: string): Promise<void> {
  console.log(`Descargando ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Descarga fallida (${res.status}): ${url}`)
  mkdirSync(join(destination, '..'), { recursive: true })
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destination))
  console.log(`  ${(statSync(destination).size / 1e6).toFixed(1)} MB`)
}

// Providers that publish "<archive>.sha256" next to the file get verified; the rest are trusted over HTTPS
async function verifyChecksum(url: string, archive: string): Promise<void> {
  const res = await fetch(`${url}.sha256`).catch(() => null)
  if (!res?.ok) return
  const expected = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase()
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (expected && expected !== actual) throw new Error(`SHA-256 incorrecto para ${url}`)
  if (expected) console.log('  SHA-256 verificado')
}

// Git for Windows puts a GNU tar on PATH that treats "C:" as a host name: use the system one
function tarBinary(): string {
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar'
}

function findExecutable(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findExecutable(path, name)
      if (found) return found
    } else if (entry.name === name) {
      return path
    }
  }
  return undefined
}

function makeExecutable(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o755)
}

function versionOf(path: string, args: string[]): string | undefined {
  try {
    return execFileSync(path, args, { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]
  } catch {
    return undefined
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
