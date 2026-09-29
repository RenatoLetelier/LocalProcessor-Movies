import { useEffect, useMemo, useState } from 'react'
import { bridge } from '@/lib/bridge'
import type { AppConfig, Standard } from '@shared/config'
import type { SystemInfo } from '@shared/api'
import { SEGMENT_DURATION_RANGE, validateConfig } from '@shared/config-validate'
import { ApiError, api } from '@/lib/api'
import { ConfirmDialog, CopyButton, type ConfirmOptions } from '@/components/ui'
import { useAppState } from '@/state/AppState'

const STANDARDS: { id: Standard; label: string; hint: string }[] = [
  { id: 'hls', label: 'HLS', hint: 'master.m3u8 — Apple, Safari, la mayoría de reproductores' },
  { id: 'dash', label: 'DASH', hint: 'manifest.mpd — mismos segmentos, sin duplicar video' }
]

export function Settings() {
  const { config, saveConfig, regenerateApiToken, importTitles } = useAppState()
  const [draft, setDraft] = useState<AppConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [imported, setImported] = useState<string | null>(null)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)

  useEffect(() => {
    if (config) setDraft(structuredClone(config))
  }, [config])

  // Concurrency depends on the saved config, so it is refreshed after every save
  useEffect(() => {
    api.system().then(setSystem).catch(() => setSystem(null))
  }, [config])

  const problems = useMemo(() => (draft ? validateConfig(draft) : []), [draft])
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config])

  if (!draft || !config) return null

  const update = (patch: Partial<AppConfig>): void => {
    setDraft({ ...draft, ...patch })
    setSaved(false)
    setImported(null)
    setServerError(null)
  }

  const pickFolder = async (): Promise<void> => {
    const folder = await bridge.pickFolder(draft.outputFolder ?? undefined)
    if (folder) update({ outputFolder: folder })
  }

  const toggleStandard = (id: Standard, on: boolean): void =>
    update({ standards: on ? [...new Set([...draft.standards, id])] : draft.standards.filter((s) => s !== id) })

  const toggleQuality = (label: string, on: boolean): void => {
    // Keep the ladder in rung definition order regardless of click order
    const enabled = new Set(draft.qualities)
    if (on) enabled.add(label)
    else enabled.delete(label)
    update({ qualities: Object.keys(draft.rungs).filter((l) => enabled.has(l)) })
  }

  const askRegenerateToken = (): void =>
    setConfirm({
      title: 'Regenerar token',
      message: 'Los programas que usan el token actual perderán el acceso hasta que reciban el nuevo.',
      confirmLabel: 'Regenerar',
      danger: true,
      onConfirm: async () => {
        await regenerateApiToken()
      }
    })

  const setBitrate = (label: string, kbps: number): void =>
    update({ rungs: { ...draft.rungs, [label]: { ...draft.rungs[label]!, maxBitrateKbps: kbps } } })

  const save = async (): Promise<void> => {
    setSaving(true)
    setServerError(null)
    try {
      // Only changed keys travel, so a stale field never overwrites a newer value
      const patch: Partial<AppConfig> = {}
      for (const key of Object.keys(draft) as (keyof AppConfig)[]) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(config[key])) (patch as Record<string, unknown>)[key] = draft[key]
      }
      await saveConfig(patch)
      setSaved(true)
      if (patch.outputFolder) {
        const summary = await importTitles()
        const found = summary.imported.length + summary.relinked.length
        setImported(found > 0 ? `${found} ${found === 1 ? 'título encontrado' : 'títulos encontrados'} en la carpeta` : null)
      }
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack settings">
      <div className="card">
        <h3 className="card__title">Carpeta de salida</h3>
        <p className="muted">Cada título se publica en una subcarpeta con su identificador. Los cambios afectan solo a los títulos nuevos.</p>
        <div className="field-row">
          <input className="input mono" readOnly value={draft.outputFolder ?? ''} placeholder="Sin definir" />
          <button type="button" className="btn" onClick={() => void pickFolder()}>
            Cambiar…
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Estándar de salida</h3>
        <div className="checks">
          {STANDARDS.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked={draft.standards.includes(s.id)} onChange={(e) => toggleStandard(s.id, e.target.checked)} />
              <span>
                <strong>{s.label}</strong>
                <span className="muted"> — {s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="card__title">Calidades</h3>
        <p className="muted">
          Cada calidad es una caja máxima: el video se escala para caber en ella conservando su aspect ratio y nunca se amplía. El bitrate es
          un techo; si el origen tiene menos, se respeta el del origen.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Etiqueta</th>
              <th>Caja máxima</th>
              <th>Bitrate máximo (kbps)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(draft.rungs).map(([label, rung]) => (
              <tr key={label} className={draft.qualities.includes(label) ? '' : 'table__row--muted'}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Generar ${label}`}
                    checked={draft.qualities.includes(label)}
                    onChange={(e) => toggleQuality(label, e.target.checked)}
                  />
                </td>
                <td>{label}</td>
                <td className="muted">
                  {rung.width}×{rung.height}
                </td>
                <td>
                  <input
                    className="input input--sm"
                    type="number"
                    min={1}
                    step={100}
                    value={rung.maxBitrateKbps}
                    onChange={(e) => setBitrate(label, Number(e.target.value))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Las calidades personalizadas (por ejemplo 1440p) se agregan por la API: <code>PUT /config</code>.</p>
      </div>

      <div className="card">
        <h3 className="card__title">Copiar el video del origen</h3>
        <label className="check">
          <input type="checkbox" checked={draft.copyVideo} onChange={(e) => update({ copyVideo: e.target.checked })} />
          <span>
            <strong>Copiar el video cuando ya es compatible</strong>
            <span className="muted">
              {' '}
              — un H.264 de 8 bits SDR que no supera el tope se publica tal cual, como calidad «original»: sin pérdida y en segundos. Al lado
              se codifica solo la calidad activa más baja, para conexiones lentas. HEVC, 10 bits y HDR se codifican siempre.
            </span>
          </span>
        </label>
        <label className="field">
          <span>Tope para copiar (kbps)</span>
          <input
            className="input input--sm"
            type="number"
            min={1}
            step={500}
            disabled={!draft.copyVideo}
            value={draft.copyVideoMaxKbps}
            onChange={(e) => update({ copyVideoMaxKbps: Number(e.target.value) })}
          />
        </label>
        <p className="muted">Lo que cabe por el enlace de quienes miran. Un origen más pesado se codifica con las calidades de arriba.</p>
      </div>

      <div className="card">
        <h3 className="card__title">Rendimiento</h3>
        {system && (
          <div className="stack-sm">
            <p className="muted">Codificadores H.264 detectados en esta máquina (probados con una codificación real al arrancar):</p>
            <ul className="encoder-list">
              {system.encoders.map((e) => (
                <li key={e.kind} className={`encoder-list__item${e.available ? '' : ' encoder-list__item--off'}`}>
                  <span className={`encoder-list__dot${e.available ? ' encoder-list__dot--ok' : ''}`} aria-hidden="true" />
                  <span>{e.label}</span>
                  {system.selectedEncoder === e.kind && <span className="chip">en uso</span>}
                  {!e.available && e.error && <span className="muted"> — {e.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="field">
          <span>Codificador</span>
          <select className="input input--sm" value={draft.encoder} onChange={(e) => update({ encoder: e.target.value as AppConfig['encoder'] })}>
            <option value="auto">Automático (hardware si existe)</option>
            <option value="software">Solo CPU (libx264, máxima calidad)</option>
          </select>
        </label>
        <label className="field">
          <span>Jobs en paralelo</span>
          <select
            className="input input--sm"
            value={draft.maxConcurrentJobs === 'auto' ? 'auto' : String(draft.maxConcurrentJobs)}
            onChange={(e) => update({ maxConcurrentJobs: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}
          >
            <option value="auto">Automático{system ? ` (ahora: ${system.concurrency})` : ''}</option>
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <p className="muted">
          En automático, cada calidad activa es una sesión del codificador: con NVENC se reparten las 8 sesiones que permite el driver, con otros
          codificadores por hardware corren 2 jobs, y con CPU uno solo (x264 ya usa todos los núcleos).
        </p>
      </div>

      <div className="card">
        <h3 className="card__title">Segmentos</h3>
        <label className="field">
          <span>Duración de cada segmento (segundos)</span>
          <input
            className="input input--sm"
            type="number"
            min={SEGMENT_DURATION_RANGE.min}
            max={SEGMENT_DURATION_RANGE.max}
            value={draft.segmentDurationSeconds}
            onChange={(e) => update({ segmentDurationSeconds: Number(e.target.value) })}
          />
        </label>
        <p className="muted">Fija el GOP del codificador (duración × fps) para que cada segmento empiece en un keyframe. Apple recomienda 6 s.</p>
      </div>

      <div className="card">
        <h3 className="card__title">Acceso desde la red</h3>
        <label className="check">
          <input type="checkbox" checked={draft.apiAccess === 'lan'} onChange={(e) => update({ apiAccess: e.target.checked ? 'lan' : 'local' })} />
          <span>
            <strong>Permitir acceso desde la red local</strong>
            <span className="muted">
              {' '}
              — la API pasa a escuchar en todas las interfaces (<code>0.0.0.0</code>) y exige un token a toda petición que no venga de este PC.
              Los programas de este equipo siguen entrando sin token.
            </span>
          </span>
        </label>
        {config.apiAccess === 'lan' && config.apiToken && (
          <div className="stack-sm" style={{ marginTop: 12 }}>
            <div className="field-row">
              <input className="input mono" readOnly value={config.apiToken} aria-label="Token de la API" />
              <CopyButton text={config.apiToken} />
              <button type="button" className="btn" onClick={askRegenerateToken}>
                Regenerar
              </button>
            </div>
            <p className="muted">
              Se envía como <code>Authorization: Bearer &lt;token&gt;</code>. La sección API muestra las direcciones y comandos listos para usar.
              Windows puede pedir permiso en el Firewall la primera vez; sin él, las otras máquinas no podrán conectarse.
            </p>
          </div>
        )}
        {draft.apiAccess === 'lan' && config.apiAccess !== 'lan' && (
          <p className="muted" style={{ marginTop: 10 }}>El token se genera al guardar y aparecerá aquí.</p>
        )}
      </div>

      {problems.length > 0 && (
        <div className="alert alert--error">
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {serverError && <div className="alert alert--error">{serverError}</div>}
      {confirm && <ConfirmDialog options={confirm} onClose={() => setConfirm(null)} />}

      <div className="actions actions--sticky">
        <button type="button" className="btn btn--primary" disabled={!dirty || problems.length > 0 || saving} onClick={() => void save()}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
        <button type="button" className="btn" disabled={!dirty || saving} onClick={() => setDraft(structuredClone(config))}>
          Descartar
        </button>
        {saved && !dirty && <span className="muted">Guardado ✓{imported ? ` · ${imported}` : ''}</span>}
      </div>
    </div>
  )
}
