import { useEffect, useState } from 'react'
import { CopyButton, Modal } from '@/components/ui'
import { api, ApiError } from '@/lib/api'
import { bridge } from '@/lib/bridge'

// Everything ffmpeg and the packager printed for one job (GET /jobs/:id/log)
export function JobOutputDialog({ jobId, label, onClose }: { jobId: string; label: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.jobOutput(jobId).then(
      (body) => !cancelled && setText(body),
      (e: unknown) => !cancelled && setError(e instanceof ApiError && e.status === 404 ? 'Este job no tiene salida registrada.' : e instanceof Error ? e.message : String(e))
    )
    return () => {
      cancelled = true
    }
  }, [jobId])

  const save = async (): Promise<void> => {
    if (text === null) return
    const path = await bridge.saveTextFile(`ffmpeg-${jobId.slice(0, 8)}.log`, text)
    if (path) setSaved(path)
  }

  const lines = text === null ? 0 : text.split('\n').filter(Boolean).length

  return (
    <Modal
      title={`Salida de ffmpeg · ${label}`}
      onClose={onClose}
      wide
      footer={
        <>
          {saved && <span className="muted">Guardado en {saved}</span>}
          {text !== null && <CopyButton text={text} />}
          <button type="button" className="btn" disabled={text === null} onClick={() => void save()}>
            Guardar…
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Cerrar
          </button>
        </>
      }
    >
      {error ? (
        <p className="muted">{error}</p>
      ) : text === null ? (
        <p className="muted">Cargando…</p>
      ) : (
        <>
          <p className="muted">
            {lines} líneas · comandos ejecutados y todo lo que imprimieron ffmpeg y el empaquetador, con la hora de cada línea.
          </p>
          <pre className="codeblock logs__output">{text}</pre>
        </>
      )}
    </Modal>
  )
}
