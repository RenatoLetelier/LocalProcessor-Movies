import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface FileSinkOptions {
  maxBytes?: number
  // Rotated copies kept next to the file: app.log → app.1.log → app.2.log …
  keep?: number
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
// Two rotated copies: at most three 10 MB files
const DEFAULT_KEEP = 2

// Plain-text mirror of the log, written synchronously so a crash right after
// an entry still leaves it on disk. Volume is low (no ffmpeg output goes here).
export class FileSink {
  private readonly maxBytes: number
  private readonly keep: number
  private size: number

  constructor(
    readonly file: string,
    options: FileSinkOptions = {}
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.keep = options.keep ?? DEFAULT_KEEP
    mkdirSync(dirname(file), { recursive: true })
    this.size = existsSync(file) ? statSync(file).size : 0
  }

  write(line: string): void {
    const data = `${line}\n`
    if (this.size + data.length > this.maxBytes && this.size > 0) this.rotate()
    appendFileSync(this.file, data, 'utf8')
    this.size += data.length
  }

  private rotate(): void {
    const rotated = (n: number): string => this.file.replace(/(\.[^.\\/]+)?$/, (ext) => `.${n}${ext}`)
    rmSync(rotated(this.keep), { force: true })
    for (let n = this.keep - 1; n >= 1; n--) {
      if (existsSync(rotated(n))) renameSync(rotated(n), rotated(n + 1))
    }
    renameSync(this.file, rotated(1))
    this.size = 0
  }
}
