import type { LogEntry } from '@shared/model'

// One line per entry, for app.log and the text export:
//   2026-09-20T10:00:00.000Z WARN  jobs     [job 6a1d9b3c] Job falló: … | {"step":"encode"}
export function formatEntry(entry: Omit<LogEntry, 'id'> & { id?: number }): string {
  const level = entry.level.toUpperCase().padEnd(5)
  const category = entry.category.padEnd(8)
  const ref = entry.job_id ? `[job ${entry.job_id.slice(0, 8)}] ` : entry.title_id ? `[título ${entry.title_id.slice(0, 8)}] ` : ''
  const context = entry.context && Object.keys(entry.context).length > 0 ? ` | ${JSON.stringify(entry.context)}` : ''
  return `${entry.ts} ${level} ${category} ${ref}${entry.message}${context}`
}

// Human sizes and durations for messages ("1,8 GB", "43 min 12 s")
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1).replace('.', ',')} ${units[unit]}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes} min ${rest} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
