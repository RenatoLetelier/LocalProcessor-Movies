import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface JobOutputWriter {
  write(line: string): void
  // The last lines written, for the error entry when the job fails
  tail(): string[]
  close(): void
}

const TAIL_LINES = 200
export const DEFAULT_KEEP_JOBS = 200

// Full ffmpeg / packager output of every job, one file per job under
// <dataDir>/logs/jobs/. Thousands of lines per movie: they stay out of the
// logs table and are read on demand (GET /jobs/:id/log).
export class JobOutputStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  path(jobId: string): string {
    return join(this.dir, `${jobId}.log`)
  }

  open(jobId: string): JobOutputWriter {
    const fd = openSync(this.path(jobId), 'a')
    const tail: string[] = []
    let closed = false
    return {
      write: (line) => {
        if (closed) return
        tail.push(line)
        if (tail.length > TAIL_LINES) tail.shift()
        writeSync(fd, `${new Date().toISOString()} ${line}\n`)
      },
      tail: () => [...tail],
      close: () => {
        if (closed) return
        closed = true
        closeSync(fd)
      }
    }
  }

  read(jobId: string): string | null {
    const file = this.path(jobId)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }

  remove(jobIds: string[]): void {
    for (const id of jobIds) rmSync(this.path(id), { force: true })
  }

  // Keeps the most recently written files; returns how many were deleted
  prune(keep = DEFAULT_KEEP_JOBS): number {
    const files = readdirSync(this.dir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => ({ name, mtime: statSync(join(this.dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    const stale = files.slice(keep)
    for (const file of stale) rmSync(join(this.dir, file.name), { force: true })
    return stale.length
  }
}
