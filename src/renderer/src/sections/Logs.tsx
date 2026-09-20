import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LogsQuery, ServerEvent } from '@shared/api'
import { LOG_CATEGORIES, type LogCategory, type LogEntry, type LogLevel } from '@shared/model'
import { JobOutputDialog } from '@/components/JobOutputDialog'
import { CopyButton, EmptyState } from '@/components/ui'
import { api } from '@/lib/api'
import { bridge, isElectron } from '@/lib/bridge'
import { JOB_TIPO_LABEL } from '@/lib/format'
import { useAppState } from '@/state/AppState'

// Narrows the view to one job or one title (set from the Jobs and Library sections)
export interface LogsFilter {
  jobId?: string
  titleId?: string
}

const PAGE = 300
// Rows kept on screen: older ones drop off the top as live entries arrive
const MAX_ROWS = 2000
const EXPORT_LIMIT = 1000

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const LEVEL_LABEL: Record<LogLevel, string> = { debug: 'Debug', info: 'Info', warn: 'Aviso', error: 'Error' }
const LEVEL_TONE: Record<LogLevel, string> = { debug: 'muted', info: 'accent', warn: 'warn', error: 'error' }
const CATEGORY_LABEL: Record<LogCategory, string> = {
  app: 'Aplicación',
  api: 'API',
  config: 'Configuración',
  titles: 'Títulos',
  jobs: 'Jobs',
  pipeline: 'Pipeline'
}

export function Logs({ filter, onFilterChange }: { filter: LogsFilter; onFilterChange: (filter: LogsFilter) => void }) {
  const { connection, titles, jobs, subscribe } = useAppState()
  const [level, setLevel] = useState<LogLevel>('info')
  const [category, setCategory] = useState<LogCategory | ''>('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasOlder, setHasOlder] = useState(false)
  const [paused, setPaused] = useState(false)
  const [pending, setPending] = useState<LogEntry[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [output, setOutput] = useState<{ jobId: string; label: string } | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // The search box waits for the user to stop typing
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  const query = useMemo<LogsQuery>(
    () => ({
      level,
      ...(category ? { category } : {}),
      ...(q ? { q } : {}),
      ...(filter.jobId ? { jobId: filter.jobId } : {}),
      ...(filter.titleId ? { titleId: filter.titleId } : {})
    }),
    [level, category, q, filter.jobId, filter.titleId]
  )

  const scrollToBottom = useCallback((): void => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.listLogs({ ...query, limit: PAGE })
      setEntries(list)
      setHasOlder(list.length === PAGE)
      setPending([])
      setPaused(false)
      requestAnimationFrame(scrollToBottom)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [query, scrollToBottom])

  // Reloaded on every filter change and on every reconnect (entries missed while offline)
  useEffect(() => {
    if (connection === 'online') void load()
  }, [connection, load])

  // Same rules the server applies, for the entries arriving live
  const matches = useCallback(
    (entry: LogEntry): boolean => {
      if (LEVEL_RANK[entry.level] < LEVEL_RANK[level]) return false
      if (category && entry.category !== category) return false
      if (filter.jobId && entry.job_id !== filter.jobId) return false
      if (filter.titleId && entry.title_id !== filter.titleId) return false
      if (q) {
        const needle = q.toLowerCase()
        const inContext = entry.context ? JSON.stringify(entry.context).toLowerCase().includes(needle) : false
        if (!entry.message.toLowerCase().includes(needle) && !inContext) return false
      }
      return true
    },
    [level, category, q, filter.jobId, filter.titleId]
  )

  useEffect(
    () =>
      subscribe((event: ServerEvent) => {
        if (event.type !== 'log.entry' || !matches(event.entry)) return
        if (paused) setPending((list) => [...list, event.entry])
        else setEntries((list) => [...list, event.entry].slice(-MAX_ROWS))
      }),
    [subscribe, matches, paused]
  )

  useEffect(() => {
    if (!paused) scrollToBottom()
  }, [entries, paused, scrollToBottom])

  const resume = (): void => {
    setEntries((list) => [...list, ...pending].slice(-MAX_ROWS))
    setPending([])
    setPaused(false)
  }

  // Scrolling up freezes the view; coming back to the bottom releases it
  const onScroll = (): void => {
    const list = listRef.current
    if (!list) return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    if (!atBottom && !paused) setPaused(true)
    else if (atBottom && paused && pending.length > 0) resume()
  }

  const loadOlder = async (): Promise<void> => {
    const first = entries[0]
    const list = listRef.current
    if (!first || !list) return
    const fromBottom = list.scrollHeight - list.scrollTop
    try {
      const older = await api.listLogs({ ...query, before: first.id, limit: PAGE })
      setEntries((current) => [...older, ...current])
      setHasOlder(older.length === PAGE)
      requestAnimationFrame(() => {
        list.scrollTop = list.scrollHeight - fromBottom
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const exportText = async (): Promise<void> => {
    try {
      const text = await api.logsText({ ...query, limit: EXPORT_LIMIT })
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const path = await bridge.saveTextFile(`localprocessor-logs-${stamp}.txt`, text)
      if (path) setExported(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = (id: number): void =>
    setExpanded((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const titleName = (id: string | null): string | null => (id ? (titles.find((t) => t.id === id)?.name ?? null) : null)
  const jobLabel = (id: string): string => {
    const job = jobs.find((j) => j.id === id)
    const name = job ? titleName(job.title_id) : null
    return job ? `${name ?? job.title_id.slice(0, 8)} · ${JOB_TIPO_LABEL[job.tipo]}` : `job ${id.slice(0, 8)}`
  }

  return (
    <div className="logs">
      <div className="card logs__toolbar">
        <select className="input input--sm" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} aria-label="Nivel mínimo">
          <option value="debug">Todo (debug)</option>
          <option value="info">Info y superior</option>
          <option value="warn">Avisos y errores</option>
          <option value="error">Solo errores</option>
        </select>
        <select className="input input--sm" value={category} onChange={(e) => setCategory(e.target.value as LogCategory | '')} aria-label="Categoría">
          <option value="">Todas las categorías</option>
          {LOG_CATEGORIES.map((id) => (
            <option key={id} value={id}>
              {CATEGORY_LABEL[id]}
            </option>
          ))}
        </select>
        <input
          className="input input--sm logs__search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar en mensajes y detalle…"
          spellCheck={false}
          aria-label="Buscar"
        />
        {filter.jobId && (
          <span className="chip logs__chip">
            Job: {jobLabel(filter.jobId)}
            <button type="button" onClick={() => onFilterChange({})} aria-label="Quitar filtro de job">
              ×
            </button>
          </span>
        )}
        {filter.titleId && (
          <span className="chip logs__chip">
            Título: {titleName(filter.titleId) ?? filter.titleId.slice(0, 8)}
            <button type="button" onClick={() => onFilterChange({})} aria-label="Quitar filtro de título">
              ×
            </button>
          </span>
        )}
        <span className="logs__spacer" />
        <button type="button" className="btn btn--sm" onClick={() => (paused ? resume() : setPaused(true))}>
          {paused ? `Reanudar${pending.length ? ` (${pending.length} nuevas)` : ''}` : 'Pausar'}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => void exportText()} title={`Guarda las últimas ${EXPORT_LIMIT} entradas del filtro actual como texto`}>
          Exportar .txt
        </button>
        {isElectron && (
          <button type="button" className="btn btn--sm" onClick={() => void bridge.openLogsFolder()} title="app.log y la salida de ffmpeg de cada job">
            Abrir carpeta de logs
          </button>
        )}
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {exported && <div className="alert alert--info">Registro guardado en {exported}</div>}

      <div className="card logs__list" ref={listRef} onScroll={onScroll}>
        {hasOlder && (
          <button type="button" className="btn btn--link logs__older" onClick={() => void loadOlder()}>
            Cargar entradas anteriores
          </button>
        )}
        {entries.length === 0 && !loading && <EmptyState title="No hay entradas con este filtro" />}
        {entries.map((entry) => (
          <LogRow
            key={entry.id}
            entry={entry}
            open={expanded.has(entry.id)}
            onToggle={() => toggle(entry.id)}
            titleName={titleName(entry.title_id)}
            onOnlyJob={entry.job_id && filter.jobId !== entry.job_id ? () => onFilterChange({ jobId: entry.job_id! }) : undefined}
            onOnlyTitle={entry.title_id && filter.titleId !== entry.title_id ? () => onFilterChange({ titleId: entry.title_id! }) : undefined}
            onOutput={entry.job_id ? () => setOutput({ jobId: entry.job_id!, label: jobLabel(entry.job_id!) }) : undefined}
          />
        ))}
      </div>

      {output && <JobOutputDialog jobId={output.jobId} label={output.label} onClose={() => setOutput(null)} />}
    </div>
  )
}

function LogRow({
  entry,
  open,
  onToggle,
  titleName,
  onOnlyJob,
  onOnlyTitle,
  onOutput
}: {
  entry: LogEntry
  open: boolean
  onToggle: () => void
  titleName: string | null
  onOnlyJob?: () => void
  onOnlyTitle?: () => void
  onOutput?: () => void
}) {
  return (
    <>
      <div className={`log log--${entry.level}${open ? ' log--open' : ''}`} onClick={onToggle} role="button" aria-expanded={open}>
        <span className="log__time mono" title={entry.ts}>
          {formatTime(entry.ts)}
        </span>
        <span className={`badge badge--${LEVEL_TONE[entry.level]}`}>{LEVEL_LABEL[entry.level]}</span>
        <span className="log__category muted">{CATEGORY_LABEL[entry.category]}</span>
        <span className="log__message">{entry.message}</span>
      </div>
      {open && <LogDetail entry={entry} titleName={titleName} onOnlyJob={onOnlyJob} onOnlyTitle={onOnlyTitle} onOutput={onOutput} />}
    </>
  )
}

function LogDetail({
  entry,
  titleName,
  onOnlyJob,
  onOnlyTitle,
  onOutput
}: {
  entry: LogEntry
  titleName: string | null
  onOnlyJob?: () => void
  onOnlyTitle?: () => void
  onOutput?: () => void
}) {
  // The ffmpeg tail and a stack trace read better as text than as JSON
  const { output, stack, ...rest } = entry.context ?? {}
  const outputLines = Array.isArray(output) ? (output as string[]) : null
  const json = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null
  const plain = [entry.ts, entry.level, entry.category, entry.message, json ?? '', outputLines?.join('\n') ?? '', typeof stack === 'string' ? stack : ''].filter(Boolean).join('\n')

  return (
    <div className="log__detail">
      <div className="log__meta muted">
        <span>{new Date(entry.ts).toLocaleString('es', { dateStyle: 'short', timeStyle: 'medium' })}</span>
        {entry.title_id && <span>Título: {titleName ?? entry.title_id}</span>}
        {entry.job_id && <span className="mono">job {entry.job_id}</span>}
        {onOnlyJob && (
          <button type="button" className="btn btn--link" onClick={onOnlyJob}>
            Solo este job
          </button>
        )}
        {onOnlyTitle && (
          <button type="button" className="btn btn--link" onClick={onOnlyTitle}>
            Solo este título
          </button>
        )}
        {onOutput && (
          <button type="button" className="btn btn--link" onClick={onOutput}>
            Salida de ffmpeg
          </button>
        )}
        <CopyButton text={plain} className="btn--link" />
      </div>
      {json && <pre className="codeblock">{json}</pre>}
      {outputLines && outputLines.length > 0 && (
        <>
          <div className="muted">Últimas líneas de ffmpeg / empaquetador:</div>
          <pre className="codeblock">{outputLines.join('\n')}</pre>
        </>
      )}
      {typeof stack === 'string' && <pre className="codeblock">{stack}</pre>}
      {!json && !outputLines?.length && typeof stack !== 'string' && <div className="muted">Sin más detalle.</div>}
    </div>
  )
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  const time = date.toLocaleTimeString('es', { hour12: false })
  return sameDay ? time : `${date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' })} ${time}`
}
