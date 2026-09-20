import { useEffect, useMemo, useState } from 'react'
import type { Job } from '@shared/model'
import { JobOutputDialog } from '@/components/JobOutputDialog'
import { ConfirmDialog, EmptyState, ProgressBar, StatusBadge, type ConfirmOptions } from '@/components/ui'
import { JOB_TIPO_LABEL, STEP_LABEL, formatDate, formatElapsed } from '@/lib/format'
import type { LogsFilter } from '@/sections/Logs'
import { useAppState } from '@/state/AppState'

const HISTORY_LIMIT = 100

export function Jobs({ onShowLogs }: { onShowLogs: (filter: LogsFilter) => void }) {
  const { jobs, titles, cancelJob } = useAppState()
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [output, setOutput] = useState<Job | null>(null)
  const [, tick] = useState(0)

  // Elapsed times of running jobs refresh once per second
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const titleName = (job: Job): string => titles.find((t) => t.id === job.title_id)?.name ?? job.title_id

  const { running, queued, history } = useMemo(() => {
    const running = jobs.filter((j) => j.status === 'running')
    const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.created_at.localeCompare(b.created_at))
    const history = jobs
      .filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled')
      .sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? ''))
      .slice(0, HISTORY_LIMIT)
    return { running, queued, history }
  }, [jobs])

  const askCancel = (job: Job): void =>
    setConfirm({
      title: 'Cancelar job',
      message: `¿Cancelar "${titleName(job)}"? ${job.status === 'running' ? 'Lo procesado hasta ahora se descarta.' : ''}`,
      confirmLabel: 'Cancelar job',
      danger: true,
      onConfirm: () => cancelJob(job.id)
    })

  return (
    <div className="stack">
      <section>
        <h2 className="section-title">En curso</h2>
        {running.length === 0 ? (
          <EmptyState title="No hay ningún job corriendo" />
        ) : (
          running.map((job) => (
            <div key={job.id} className="card job">
              <div className="job__header">
                <div>
                  <div className="job__name">{titleName(job)}</div>
                  <div className="muted">
                    {JOB_TIPO_LABEL[job.tipo]} · {STEP_LABEL[job.current_step ?? ''] ?? 'Iniciando'} · {formatElapsed(job.started_at)}
                    {job.attempts > 1 && ` · intento ${job.attempts}`}
                  </div>
                </div>
                <div className="job__percent">{job.progress.toFixed(0)}%</div>
                <button type="button" className="btn" onClick={() => onShowLogs({ jobId: job.id })}>
                  Ver logs
                </button>
                <button type="button" className="btn btn--danger-outline" onClick={() => askCancel(job)}>
                  Cancelar
                </button>
              </div>
              <ProgressBar percent={job.progress} />
            </div>
          ))
        )}
      </section>

      <section>
        <h2 className="section-title">En cola ({queued.length})</h2>
        {queued.length === 0 ? (
          <EmptyState title="La cola está vacía" />
        ) : (
          <div className="card">
            <table className="table">
              <tbody>
                {queued.map((job, i) => (
                  <tr key={job.id}>
                    <td className="muted">{i + 1}</td>
                    <td>{titleName(job)}</td>
                    <td className="muted">{JOB_TIPO_LABEL[job.tipo]}</td>
                    <td className="muted">{formatDate(job.created_at)}</td>
                    <td className="table__actions">
                      <button type="button" className="btn btn--sm btn--link" onClick={() => onShowLogs({ jobId: job.id })}>
                        Ver logs
                      </button>
                      <button type="button" className="btn btn--sm" onClick={() => askCancel(job)}>
                        Cancelar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="section-title">Historial</h2>
        {history.length === 0 ? (
          <EmptyState title="Todavía no hay jobs terminados" />
        ) : (
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Título</th>
                  <th>Tipo</th>
                  <th>Estado</th>
                  <th>Duración</th>
                  <th>Terminado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((job) => (
                  <tr key={job.id}>
                    <td>
                      {titleName(job)}
                      {job.error && <div className="table__note">{job.error}</div>}
                    </td>
                    <td className="muted">{JOB_TIPO_LABEL[job.tipo]}</td>
                    <td>
                      <StatusBadge status={job.status} kind="job" />
                    </td>
                    <td className="muted">{formatElapsed(job.started_at, job.finished_at)}</td>
                    <td className="muted">{formatDate(job.finished_at)}</td>
                    <td className="table__actions">
                      <button type="button" className="btn btn--sm btn--link" onClick={() => onShowLogs({ jobId: job.id })}>
                        Ver logs
                      </button>
                      <button type="button" className="btn btn--sm btn--link" onClick={() => setOutput(job)}>
                        Salida de ffmpeg
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirm && <ConfirmDialog options={confirm} onClose={() => setConfirm(null)} />}
      {output && <JobOutputDialog jobId={output.id} label={`${titleName(output)} · ${JOB_TIPO_LABEL[output.tipo]}`} onClose={() => setOutput(null)} />}
    </div>
  )
}
