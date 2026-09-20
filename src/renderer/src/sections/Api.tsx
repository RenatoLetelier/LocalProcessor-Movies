import { useEffect, useState } from 'react'
import type { SystemInfo } from '@shared/api'
import { DEFAULT_API_HOST } from '@shared/constants'
import { CopyButton } from '@/components/ui'
import { api, apiBaseUrl } from '@/lib/api'
import { bridge } from '@/lib/bridge'
import { fileName } from '@/lib/format'
import { useAppState } from '@/state/AppState'

const ON_WINDOWS = navigator.userAgent.includes('Windows')
const EXAMPLE_PATH = ON_WINDOWS ? 'C:\\Peliculas\\pelicula.mkv' : '/home/usuario/Peliculas/pelicula.mkv'
const EXAMPLE_TITLE_ID = '0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60'
const EXAMPLE_JOB_ID = '6a1d9b3c-2e4f-4a5b-8c7d-9e0f1a2b3c4d'
const EXAMPLE_TIME = new Date().toISOString()

interface CurlCommand {
  // Shown with line continuations, copied as one line so it pastes into Postman or any shell
  display: string
  copy: string
}

const curl = (parts: string[]): CurlCommand => ({ display: parts.join(' \\\n  '), copy: parts.join(' ') })

// Single quotes are what Postman's importer and every shell agree on; a value with
// one inside falls back to escaped double quotes
function shellArg(value: string): string {
  return value.includes("'") ? `"${value.replace(/["\\]/g, '\\$&')}"` : `'${value}'`
}

const ENDPOINTS: { method: string; path: string; description: string }[] = [
  { method: 'POST', path: '/titles', description: 'Registra un archivo (JSON con sourcePath o multipart con file) y lo encola' },
  { method: 'GET', path: '/titles', description: 'Lista de títulos con su estado' },
  { method: 'GET', path: '/titles/:id', description: 'Detalle: calidades, pistas de audio y subtítulos, jobs' },
  { method: 'GET', path: '/titles/:id/files', description: 'Árbol de archivos publicado con tamaños' },
  { method: 'POST', path: '/titles/:id/reprocess', description: '{ tipo: "agregar_calidad" | "agregar_pista" | "reprocesar_completo", … }' },
  { method: 'PUT', path: '/titles/:id/source', description: 'Vincula el archivo de origen de un título: { sourcePath }' },
  { method: 'DELETE', path: '/titles/:id', description: 'Elimina el título, su carpeta y el archivo subido (si lo hubo)' },
  { method: 'POST', path: '/titles/import', description: 'Importa los títulos publicados en la carpeta de salida que no estén en la biblioteca' },
  { method: 'GET', path: '/jobs', description: 'Jobs activos; ?status=all para el historial completo' },
  { method: 'GET', path: '/jobs/:id', description: 'Estado y progreso de un job' },
  { method: 'GET', path: '/jobs/:id/log', description: 'Salida completa de ffmpeg y del empaquetador del job (texto)' },
  { method: 'POST', path: '/jobs/:id/cancel', description: 'Cancela un job en cola o en curso' },
  { method: 'WS', path: '/jobs/stream', description: 'Eventos en tiempo real (job.progress, job.updated, title.updated…)' },
  { method: 'GET', path: '/config', description: 'Configuración actual (estándares, calidades, segmentos, codificador)' },
  { method: 'PUT', path: '/config', description: 'Actualiza la configuración' },
  { method: 'POST', path: '/config/api-token', description: 'Regenera el token de acceso desde la red (revoca el anterior)' },
  { method: 'GET', path: '/system', description: 'Codificadores detectados, concurrencia, dirección de escucha e IPs del equipo' },
  { method: 'GET', path: '/logs', description: 'Registro de acciones: ?level=&category=&jobId=&titleId=&q=&before=&limit=&format=text' },
  { method: 'GET', path: '/health', description: 'Versión de la aplicación' }
]

export function Api() {
  const { connection, apiVersion, config } = useAppState()
  const [localBase, setLocalBase] = useState('')
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [host, setHost] = useState(DEFAULT_API_HOST)
  const [path, setPath] = useState(EXAMPLE_PATH)
  const [name, setName] = useState('')

  useEffect(() => {
    void apiBaseUrl().then(setLocalBase)
  }, [])

  // Switching LAN access re-binds the server a moment after the config changes
  const lan = config?.apiAccess === 'lan'
  useEffect(() => {
    const load = (): Promise<void> => api.system().then(setSystem, () => setSystem(null))
    void load()
    const timer = setTimeout(() => void load(), 1500)
    return () => clearTimeout(timer)
  }, [lan])

  const lanAddresses = lan ? (system?.lanAddresses ?? []) : []
  const remote = host !== DEFAULT_API_HOST && lanAddresses.includes(host)
  const port = localBase ? new URL(localBase).port || '80' : ''
  const base = remote ? `http://${host}:${port}` : localBase
  const wsBase = base.replace(/^http/, 'ws')
  const token = config?.apiToken ?? ''
  const auth = remote ? [`-H ${shellArg(`Authorization: Bearer ${token}`)}`] : []
  const wsUrl = `${wsBase}/jobs/stream${remote ? `?token=${token}` : ''}`

  const sourcePath = path.trim() || EXAMPLE_PATH
  const title = name.trim()
  const outputFolder = config?.outputFolder ?? (ON_WINDOWS ? 'D:\\LocalProcessor-Movies' : '/srv/localprocessor-movies')
  const titleFolder = `${outputFolder}${ON_WINDOWS ? '\\' : '/'}${EXAMPLE_TITLE_ID}`

  const jsonCurl = curl([
    `curl -X POST ${base}/titles`,
    ...auth,
    `-H 'Content-Type: application/json'`,
    `-d ${shellArg(JSON.stringify({ sourcePath, ...(title ? { name: title } : {}) }))}`
  ])
  const uploadCurl = curl([
    `curl -X POST ${base}/titles`,
    ...auth,
    `-F ${shellArg(`file=@${sourcePath}`)}`,
    ...(title ? [`-F ${shellArg(`name=${title}`)}`] : [])
  ])
  const jobCurl = curl([`curl ${base}/jobs/${EXAMPLE_JOB_ID}`, ...auth])
  const titleCurl = curl([`curl ${base}/titles/${EXAMPLE_TITLE_ID}`, ...auth])
  const filesCurl = curl([`curl ${base}/titles/${EXAMPLE_TITLE_ID}/files`, ...auth])

  const created = JSON.stringify(
    {
      title: {
        id: EXAMPLE_TITLE_ID,
        name: title || fileName(sourcePath).replace(/\.[^.]+$/, ''),
        source_path: sourcePath,
        source_managed: false,
        source_hash: '…',
        source_width: 1920,
        source_height: 1080,
        source_video_codec: 'h264',
        source_hdr: null,
        source_fps: 23.976,
        source_video_bitrate: 8500000,
        duration_seconds: 5400,
        output_folder: titleFolder,
        status: 'queued',
        error: null,
        created_at: EXAMPLE_TIME,
        updated_at: EXAMPLE_TIME
      },
      job: {
        id: EXAMPLE_JOB_ID,
        title_id: EXAMPLE_TITLE_ID,
        tipo: 'inicial',
        status: 'queued',
        progress: 0,
        current_step: null,
        error: null,
        attempts: 0,
        config_json: '{…}',
        created_at: EXAMPLE_TIME,
        started_at: null,
        finished_at: null
      }
    },
    null,
    2
  )

  const pick = async (): Promise<void> => {
    const [chosen] = await bridge.pickVideoFiles()
    if (chosen) setPath(chosen)
  }

  return (
    <div className="stack docs">
      <div className="card">
        <h3 className="card__title">Dirección</h3>
        <dl className="props">
          <dt>Llamar desde</dt>
          <dd>
            <select className="input input--sm" value={remote ? host : DEFAULT_API_HOST} onChange={(e) => setHost(e.target.value)}>
              <option value={DEFAULT_API_HOST}>Este PC ({DEFAULT_API_HOST})</option>
              {lanAddresses.map((ip) => (
                <option key={ip} value={ip}>
                  Otra máquina de la red ({ip})
                </option>
              ))}
            </select>
          </dd>
          <dt>URL base</dt>
          <dd>
            <span className="mono">{base}</span> <CopyButton text={base} className="btn--link" />
          </dd>
          <dt>WebSocket</dt>
          <dd className="mono">{wsUrl}</dd>
          <dt>Estado</dt>
          <dd>
            {connection === 'online' ? `Conectada · versión ${apiVersion ?? '?'}` : connection === 'offline' ? 'Sin conexión' : 'Conectando…'}
            {system?.listening && ` · escuchando en ${system.listening.host}:${system.listening.port}`}
          </dd>
          <dt>Acceso</dt>
          <dd>
            {lan ? (
              <>
                Habilitado para la red local. Los programas de este PC entran sin token; cualquier otra máquina debe enviar{' '}
                <code>Authorization: Bearer &lt;token&gt;</code> (o <code>X-Api-Key</code>) en cada petición y <code>?token=</code> en el
                WebSocket.
                {lanAddresses.length === 0 && ' No se detectó ninguna dirección IPv4 de red en este equipo.'}
              </>
            ) : (
              <>
                Solo desde este PC (<code>127.0.0.1</code>) y sin autenticación. Para aceptar llamadas de otras máquinas activa{' '}
                <em>Permitir acceso desde la red local</em> en Configuración: la API pasa a exigir un token generado por la aplicación.
              </>
            )}
          </dd>
          {lan && token && (
            <>
              <dt>Token</dt>
              <dd>
                <span className="mono">{token}</span> <CopyButton text={token} className="btn--link" />
              </dd>
            </>
          )}
        </dl>
        <p className="muted" style={{ marginTop: 10 }}>
          REST con JSON y un canal WebSocket. Los procesados encolados por la API usan la misma configuración que la interfaz (estándares,
          calidades, duración de segmento y carpeta de salida) salvo que la petición indique otra cosa.
        </p>
      </div>

      <div className="card">
        <h3 className="card__title">
          <Endpoint method="POST" path="/titles" /> · Entregar una película
        </h3>
        <p>
          Registra el archivo, lo analiza con ffprobe y crea el job inicial. Responde en cuanto el título queda en cola; el procesado sigue
          en segundo plano. Completa los campos para obtener los comandos exactos:
        </p>
        <div className="api-form">
          <label htmlFor="api-path">Ruta del archivo</label>
          <div className="field-row">
            <input id="api-path" className="input" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
            <button type="button" className="btn" onClick={() => void pick()}>
              Elegir…
            </button>
          </div>
          <label htmlFor="api-name">Nombre (opcional)</label>
          <input id="api-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Por defecto, el nombre del archivo" />
        </div>

        <h4>Opción 1 · Por ruta local (JSON)</h4>
        <p>
          Para programas que corren en este PC o que ven el archivo en una unidad de red montada aquí. El archivo no se copia: se procesa
          desde donde está y debe seguir ahí para reprocesados futuros (agregar una calidad necesita el original).
          {remote && (
            <>
              {' '}
              <strong>Desde otra máquina la ruta se resuelve en este PC</strong>: tiene que ser una ruta que este equipo pueda abrir (por
              ejemplo, una carpeta compartida montada aquí), no una ruta del equipo que llama.
            </>
          )}
        </p>
        <CodeBlock text={jsonCurl.display} copy={jsonCurl.copy} />

        <h4>Opción 2 · Subiendo el archivo (multipart)</h4>
        <p>
          El archivo viaja en el cuerpo de la petición, en el campo <code>file</code> (uno por petición, sin límite de tamaño), y se guarda
          en <code>{outputFolder}{ON_WINDOWS ? '\\' : '/'}.uploads</code>. Los campos opcionales van como campos de texto del mismo formulario, con las listas separadas por
          coma (<code>qualities=1080p,720p</code>).
        </p>
        <CodeBlock text={uploadCurl.display} copy={uploadCurl.copy} />
        <p className="muted">
          <strong>Copiar</strong> entrega el comando en una sola línea: en Postman, <em>Import → Raw text</em>; en una terminal, tal cual (en
          PowerShell usa <code>curl.exe</code>).
        </p>

        <h4>Campos opcionales</h4>
        <table className="table">
          <thead>
            <tr>
              <th>Campo</th>
              <th>Tipo</th>
              <th>Descripción</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>name</code>
              </td>
              <td>texto</td>
              <td>Nombre del título. Por defecto, el nombre del archivo sin extensión.</td>
            </tr>
            <tr>
              <td>
                <code>standards</code>
              </td>
              <td>lista</td>
              <td>
                <code>["hls","dash"]</code> o un subconjunto. Por defecto, los de Configuración.
              </td>
            </tr>
            <tr>
              <td>
                <code>qualities</code>
              </td>
              <td>lista</td>
              <td>
                Etiquetas de la escalera (<code>"1080p"</code>, <code>"720p"</code>…). Deben existir en Configuración; las mayores que el
                origen se omiten (nunca se hace upscaling).
              </td>
            </tr>
            <tr>
              <td>
                <code>segmentDurationSeconds</code>
              </td>
              <td>número</td>
              <td>Duración de los segmentos en segundos. Por defecto, la de Configuración (6).</td>
            </tr>
          </tbody>
        </table>

        <h4>Respuesta 201 Created</h4>
        <p>
          Guarda <code>title.id</code> (identifica el título y su carpeta de salida) y <code>job.id</code> (para seguir el progreso). Con la
          subida multipart, <code>source_path</code> apunta a la copia en <code>.uploads</code> y <code>source_managed</code> es{' '}
          <code>true</code>.
        </p>
        <CodeBlock text={created} />

        <h4>Errores</h4>
        <p>
          Siempre con cuerpo <code>{'{ "statusCode", "error", "message" }'}</code>; algunos añaden campos, por ejemplo <code>titleId</code> en
          el 409 de archivo repetido.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Cuándo</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>
                Falta <code>sourcePath</code> o no es una ruta absoluta; el archivo no existe; ffprobe no pudo analizarlo; no hay espacio
                suficiente en la carpeta de salida (<code>requiredBytes</code>, <code>freeBytes</code>); en multipart, falta el campo{' '}
                <code>file</code> o hay más de un archivo.
              </td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>
                El archivo ya está registrado (<code>titleId</code> del título existente); la carpeta de salida no está configurada o ya no
                existe.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>Título o job inexistente en las rutas con id.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 className="card__title">Seguir el progreso</h3>
        <p>
          <Endpoint method="GET" path="/jobs/:id" /> devuelve el job: <code>status</code> pasa de <code>queued</code> a <code>running</code>{' '}
          y termina en <code>done</code>, <code>error</code> (con el motivo en <code>error</code>) o <code>cancelled</code>;{' '}
          <code>progress</code> va de 0 a 100 y <code>current_step</code> indica la etapa (<code>probe</code>, <code>plan</code>,{' '}
          <code>encode</code>, <code>package</code>, <code>publish</code>).
        </p>
        <CodeBlock text={jobCurl.display} copy={jobCurl.copy} />
        <p>
          <Endpoint method="GET" path="/titles/:id" /> devuelve el título con sus calidades, pistas y jobs; su <code>status</code> queda en{' '}
          <code>done</code> cuando la carpeta está publicada. <Endpoint method="POST" path="/jobs/:id/cancel" /> cancela un job en cola o en
          curso.
        </p>
        <CodeBlock text={titleCurl.display} copy={titleCurl.copy} />
        <p>
          Para no consultar en bucle, el WebSocket <code>{wsUrl}</code> envía primero <code>{'{ "type": "snapshot", "jobs": [...] }'}</code>{' '}
          con los jobs activos y después un mensaje JSON por evento
          {remote && ' (desde la red el token viaja en ?token=, porque un navegador no puede añadir cabeceras a un WebSocket)'}:
        </p>
        <ul>
          <li>
            <code>job.progress</code> — avance de un job en curso (<code>progress</code>, <code>current_step</code>).
          </li>
          <li>
            <code>job.updated</code> — cambio de estado de un job (empezó, terminó, falló, se canceló).
          </li>
          <li>
            <code>title.updated</code> / <code>title.deleted</code> — cambio de estado o eliminación de un título.
          </li>
          <li>
            <code>job.log</code> — líneas de ffmpeg y del empaquetador, útiles para diagnóstico.
          </li>
          <li>
            <code>config.updated</code> — la configuración cambió.
          </li>
          <li>
            <code>log.entry</code> — nueva entrada del registro de acciones (la misma que devuelve <code>GET /logs</code>).
          </li>
        </ul>
        <CodeBlock
          text={[
            `const ws = new WebSocket('${wsUrl}')`,
            'ws.onmessage = (message) => {',
            '  const event = JSON.parse(message.data)',
            "  if (event.type === 'job.updated' && event.job.status === 'done') console.log('listo', event.job.title_id)",
            '}'
          ].join('\n')}
        />
      </div>

      <div className="card">
        <h3 className="card__title">Recoger el resultado</h3>
        <p>
          Cuando el job termina en <code>done</code>, la carpeta <code>output_folder</code> de la respuesta (
          <span className="mono">{titleFolder}</span>) contiene el paquete completo:
        </p>
        <CodeBlock
          text={[
            'master.m3u8            HLS',
            'manifest.mpd           DASH (mismos segmentos)',
            'metadata.json          resumen del título para sistemas externos',
            'video/<calidad>/       init.mp4, seg_00001.m4s…, playlist.m3u8',
            'audio/<pista>/         init.mp4, seg_00001.m4s…, playlist.m3u8',
            'subs/<pista>/          seg_00001.vtt…, playlist.m3u8'
          ].join('\n')}
        />
        <p>
          <code>metadata.json</code> describe lo publicado: <code>titleId</code>, <code>name</code>, <code>durationSeconds</code>,{' '}
          <code>standards</code>, <code>manifests</code> (ruta relativa de cada manifiesto), <code>segmentDurationSeconds</code> y las listas{' '}
          <code>renditions</code>, <code>audioTracks</code> y <code>subtitleTracks</code> con idioma, códec, canales y ruta de cada una. Los
          manifiestos y <code>metadata.json</code> se reemplazan siempre de forma atómica: nunca se leen a medio escribir.
        </p>
        <p>
          <Endpoint method="GET" path="/titles/:id/files" /> devuelve el mismo árbol como JSON con tamaños, y{' '}
          <Endpoint method="DELETE" path="/titles/:id" /> elimina el título junto con su carpeta.
        </p>
        <CodeBlock text={filesCurl.display} copy={filesCurl.copy} />
      </div>

      <div className="card">
        <h3 className="card__title">Todos los endpoints</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Método</th>
              <th>Ruta</th>
              <th>Descripción</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`}>
                <td>
                  <span className="endpoint__method">{endpoint.method}</span>
                </td>
                <td>
                  <code>{endpoint.path}</code>
                </td>
                <td>{endpoint.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <span className="endpoint">
      <span className="endpoint__method">{method}</span>
      <code>{path}</code>
    </span>
  )
}

function CodeBlock({ text, copy }: { text: string; copy?: string }) {
  return (
    <pre className={`codeblock${copy ? ' codeblock--copy' : ''}`}>
      {copy && <CopyButton text={copy} className="codeblock__copy" />}
      {text}
    </pre>
  )
}
