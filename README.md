# LocalProcessor-Movies

**Motor de transcodificación VOD de escritorio.** Recibe una película (`.mkv`,
`.mp4`, `.avi`…) y publica una carpeta lista para *streaming adaptativo* — HLS
y DASH sobre un mismo set de segmentos CMAF — con todas las calidades, pistas de
audio y subtítulos, para que **otro sistema la sirva**: en particular
[Localcloud](#2-cómo-encaja-en-localcloud).

- Aplicación de escritorio (Windows, macOS, Linux) autocontenida: incluye ffmpeg,
  ffprobe y Shaka Packager. Sin Docker, sin Redis, sin nada más que instalar.
- Se maneja desde su interfaz o desde una **API REST + WebSocket** en
  `http://127.0.0.1:4700`.
- Código bajo licencia MIT.

**Índice**

1. [Qué hace y qué no hace](#1-qué-hace-y-qué-no-hace)
2. [Cómo encaja en Localcloud](#2-cómo-encaja-en-localcloud)
3. [Instalación](#3-instalación)
4. [Qué produce](#4-qué-produce)
5. [Guía de integración paso a paso](#5-guía-de-integración-paso-a-paso)
6. [Referencia de la API](#6-referencia-de-la-api)
7. [Desarrollo](#7-desarrollo)
8. [Instaladores y versiones](#8-instaladores-y-versiones)
9. [Licencias](#9-licencias)

Los documentos de diseño (funcional y técnico) están en [`docs/`](docs/).

---

## 1. Qué hace y qué no hace

**Hace**

- Analiza el archivo con ffprobe y genera una **escalera de calidades H.264**
  (por defecto 2160p, 1080p, 720p y 480p) sin superar nunca la resolución del
  original: cada calidad es una caja máxima y el video se escala para caber en
  ella conservando el aspect ratio.
- Empaqueta todo en **segmentos CMAF (fMP4)** y escribe `master.m3u8` (HLS),
  `manifest.mpd` (DASH) y un `metadata.json` que describe el título, para que
  el consumidor no tenga que parsear manifiestos.
- **Conserva todas las pistas de audio** (AAC y Dolby se copian; el resto se
  convierte a AAC) y **todos los subtítulos de texto** (convertidos a WebVTT).
- Convierte los orígenes **HDR** (HDR10, HLG, Dolby Vision con base HDR10) a
  SDR con *tone-mapping*: colores correctos en cualquier pantalla y navegador.
- Mantiene una **cola de trabajos persistente** (SQLite) con progreso en tiempo
  real; los trabajos interrumpidos por un cierre inesperado se vuelven a
  encolar al arrancar.
- **Reprocesa de forma incremental**: agregar una calidad o una pista, o rehacer
  un título completo, sin dejar de servir lo ya publicado.
- **Reconstruye su biblioteca** a partir de la carpeta de salida: si la carpeta
  se mueve o la base de datos se pierde, los títulos publicados se reimportan.
- Usa la **aceleración por hardware** disponible (NVENC, Quick Sync, AMF, VAAPI,
  VideoToolbox) y cae a CPU (libx264) si no hay ninguna.
- **Registra todo lo que hace** (sección *Logs*, en tiempo real): cada acción,
  cada paso de cada job con su duración y, cuando algo falla, el error con su
  traza, el comando ejecutado y la salida de ffmpeg.

**No hace**

- No reproduce video ni **sirve archivos por HTTP**: eso lo hace el sistema
  consumidor (Localcloud).
- No cifra (sin DRM), no hace directo (solo VOD) y no gestiona usuarios.
- No convierte **subtítulos de imagen** (PGS, VobSub, DVB): los registra como
  pendientes y no los incluye.
- No genera miniaturas, pósteres ni previsualizaciones.

---

## 2. Cómo encaja en Localcloud

LocalProcessor-Movies es un servicio de conversión que corre en un PC de la red.
Localcloud le entrega películas por la API, espera a que terminen y sirve la
carpeta resultante a los reproductores.

```
Localcloud (backend)                          LocalProcessor-Movies (app de escritorio · API 127.0.0.1:4700)
────────────────────────────────────          ─────────────────────────────────────────────────────
1. POST /titles { sourcePath }        ──────▶ registra el título, lo encola y responde 201 { title, job }
2. WS /jobs/stream  (o GET /jobs/:id) ◀────── job.progress … job.updated { status: "done" }
                                              ffprobe → ffmpeg → Shaka Packager → publicación atómica
3. lee <salida>/<title.id>/metadata.json ◀─── carpeta publicada
4. sirve <salida>/<title.id>/ por HTTP  ────▶ reproductores (hls.js, Shaka Player, Safari, Smart TV)
```

**Reparto de responsabilidades**

| | LocalProcessor-Movies | Localcloud |
|---|---|---|
| Guardar el archivo original | No: lo procesa desde donde está (si se sube por multipart, guarda una copia en `.uploads/`) | Sí |
| Analizar, convertir y empaquetar | Sí | No |
| Catálogo de títulos (id, estado, calidades, pistas) | Base propia (SQLite), consultable por la API | Copia lo que necesite de `metadata.json` o de `GET /titles/:id` |
| Servir manifiestos y segmentos por HTTP | No | Sí: servidor de archivos estáticos con los tipos MIME correctos |
| Reproducir | No | Sí (hls.js, Shaka Player, Safari, apps de TV) |

**Requisitos de la integración** — lo que hay que saber antes de escribir código:

1. **La API existe mientras la aplicación está abierta.** Vive dentro de la app
   de escritorio; al cerrar la ventana se detiene (en macOS sigue mientras la
   app esté en el Dock). No hay servicio en segundo plano.
2. **Se integra desde el backend, no desde el navegador.** La API solo permite
   CORS al origen de su propia ventana: una página web de otro origen ve sus
   peticiones bloqueadas y su WebSocket cerrado con código `1008`. Los clientes
   sin cabecera `Origin` (Node, Python, curl, cualquier servidor) entran sin
   problema.
3. **Mismo PC o red local.** En el mismo PC se usa `http://127.0.0.1:4700` sin
   autenticación. Desde otra máquina hay que activar *Permitir acceso desde la
   red local* en Configuración y enviar el token que genera la aplicación
   (`Authorization: Bearer <token>`). Es HTTP sin cifrar: pensado para una red
   doméstica o de confianza.
4. **`sourcePath` se resuelve en el PC de LocalProcessor-Movies.** Debe ser una ruta
   absoluta que ese equipo pueda abrir. Si Localcloud corre en otra máquina,
   sube el archivo por multipart o usa una carpeta compartida montada en el PC
   de LocalProcessor-Movies.
5. **La carpeta de salida la tienen que ver los dos.** LocalProcessor-Movies escribe
   en ella; Localcloud la sirve. Si no comparten disco, comparte la carpeta por
   la red (SMB/NFS) o monta el servidor de archivos de Localcloud en el mismo PC.
6. **El original debe seguir existiendo** para reprocesar más adelante (agregar
   una calidad necesita el archivo de origen). Un título cuyo original
   desapareció sigue sirviéndose, pero no se puede ampliar.
7. **Un archivo, un título.** `POST /titles` con una ruta ya registrada responde
   `409` con el `titleId` existente; para rehacerlo, usa el reprocesado.

---

## 3. Instalación

Descarga el instalador de tu sistema desde la página de
[*releases*](https://github.com/RenatoLetelier/LocalProcessor-Movies/releases) y
ejecútalo. Todo viene incluido; no hay que instalar nada más.

| Sistema | Archivo | Notas |
|---|---|---|
| Windows 10/11 x64 | `LocalProcessor-Movies-<versión>-win-x64.exe` | Instalación por usuario (sin administrador) en `%LOCALAPPDATA%\Programs\LocalProcessor-Movies`. Al no estar firmado, SmartScreen muestra *editor desconocido*: **Más información → Ejecutar de todas formas**. |
| macOS (Apple Silicon o Intel) | `LocalProcessor-Movies-<versión>-mac-arm64.dmg` o `-mac-x64.dmg` | Sin firmar: la primera vez hay que autorizarla en *Privacidad y seguridad*. En Apple Silicon, ffmpeg corre a través de Rosetta 2. |
| Linux x64 | `LocalProcessor-Movies-<versión>-linux-x86_64.AppImage` o `-linux-amd64.deb` | El AppImage no necesita instalación (`chmod +x` y ejecutar). |

Al abrirla por primera vez pide la **carpeta de salida**: ahí publicará una
subcarpeta por título. Conviene un disco con espacio de sobra (ver
[tiempos y espacio](#510-tiempos-y-espacio)). Si la carpeta ya contiene títulos
publicados por otra instalación, los importa en ese momento.

La aplicación guarda su base de datos y configuración en:

| Sistema | Carpeta de datos |
|---|---|
| Windows | `%APPDATA%\LocalProcessor-Movies` |
| macOS | `~/Library/Application Support/LocalProcessor-Movies` |
| Linux | `~/.config/LocalProcessor-Movies` |

Dentro de esa carpeta, `logs/app.log` es el registro de todo lo que hace la
aplicación (rotado a 10 MB, tres archivos) y `logs/jobs/<jobId>.log` guarda la
salida completa de ffmpeg y del Packager de cada job (se conservan los últimos
200). El mismo registro se consulta desde la API (`GET /logs`).

Hasta la versión 1.0.0 la aplicación se llamaba *LocalProcessor* y usaba la
carpeta `LocalProcessor` del mismo sitio: la primera vez que arranca la versión
renombrada copia esa base de datos, así que la biblioteca se conserva. La
versión antigua queda instalada como programa aparte y se puede desinstalar.

Al arrancar detecta los codificadores disponibles (se ven en *Configuración* y
en `GET /system`). Si un codificador por hardware falla, el trabajo se repite
con libx264 automáticamente.

---

## 4. Qué produce

### 4.1 La carpeta de un título

Cada título se publica en `<carpeta de salida>/<uuid>/`, donde `<uuid>` es el
`id` del título en la API:

```
<salida>/0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60/
├── master.m3u8              manifiesto HLS
├── manifest.mpd             manifiesto DASH (mismos segmentos)
├── metadata.json            descripción del título (ver 4.2)
├── video/
│   ├── 1080p/               init.mp4, seg_00001.m4s, seg_00002.m4s…, playlist.m3u8
│   ├── 720p/
│   └── 480p/
├── audio/
│   ├── 1_es_ac3/            pista 1 del origen, español, AC-3 copiado
│   ├── 1_es_aac/            la misma pista en AAC (para navegadores sin Dolby)
│   └── 2_en_aac/
└── subs/
    ├── 3_es/                seg_00001.vtt…, playlist.m3u8
    └── 4_en/
```

- Las pistas se nombran `<índice en el origen>_<idioma>_<códec>` (audio) y
  `<índice>_<idioma>` (subtítulos). Las añadidas desde un archivo externo usan
  `e1`, `e2`… como índice.
- Dentro de la carpeta de salida hay dos carpetas internas: `.tmp/` (trabajos en
  curso) y `.uploads/` (originales subidos por la API). **No las sirvas ni las
  borres a mano.**
- Los segmentos de un título **nunca se reescriben**; solo `master.m3u8`,
  `manifest.mpd` y `metadata.json` se reemplazan, y siempre de forma atómica
  (archivo temporal + *rename*): un lector ve la versión anterior completa o la
  nueva completa, nunca un archivo a medias.

### 4.2 `metadata.json`

Se escribe al publicar y se actualiza en cada reprocesado. Es la fuente de
verdad para el consumidor: con este archivo y la carpeta, Localcloud tiene todo
lo que necesita sin llamar a la API.

```json
{
  "schemaVersion": 1,
  "titleId": "0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60",
  "name": "La película",
  "durationSeconds": 5400.5,
  "standards": ["hls", "dash"],
  "manifests": { "hls": "master.m3u8", "dash": "manifest.mpd" },
  "segmentDurationSeconds": 6.006,
  "dynamicRange": { "source": "sdr", "output": "sdr" },
  "source": {
    "path": "C:/Peliculas/La pelicula.mkv",
    "sizeBytes": 8321457203,
    "width": 1920,
    "height": 1080,
    "fps": 23.976,
    "codec": "h264",
    "bitrate": 12000000
  },
  "renditions": [
    { "label": "1080p", "width": 1920, "height": 1080, "bitrate": 5412000, "maxBitrate": 6000000, "codec": "h264", "path": "video/1080p" },
    { "label": "720p",  "width": 1280, "height": 720,  "bitrate": 2790000, "maxBitrate": 3000000, "codec": "h264", "path": "video/720p" },
    { "label": "480p",  "width": 854,  "height": 480,  "bitrate": 1380000, "maxBitrate": 1500000, "codec": "h264", "path": "video/480p" }
  ],
  "audioTracks": [
    { "id": "1_es_ac3", "language": "es", "name": "Español", "codec": "ac3", "channels": 6, "path": "audio/1_es_ac3", "sourceIndex": 1, "sourceCodec": "ac3" },
    { "id": "1_es_aac", "language": "es", "name": "Español", "codec": "aac", "channels": 6, "path": "audio/1_es_aac", "sourceIndex": 1, "sourceCodec": "ac3" },
    { "id": "2_en_aac", "language": "en", "name": "English", "codec": "aac", "channels": 2, "path": "audio/2_en_aac", "sourceIndex": 2, "sourceCodec": "aac" }
  ],
  "subtitleTracks": [
    { "id": "3_es", "language": "es", "name": "Español", "format": "vtt", "forced": false, "path": "subs/3_es", "sourceIndex": 3, "sourceFormat": "subrip" },
    { "id": "4_en", "language": "en", "name": "English", "format": "vtt", "forced": true,  "path": "subs/4_en", "sourceIndex": 4, "sourceFormat": "ass" }
  ],
  "updatedAt": "2026-09-18T03:12:45.120Z"
}
```

| Campo | Significado |
|---|---|
| `schemaVersion` | Versión del formato; hoy siempre `1`. |
| `titleId` | Igual al nombre de la carpeta y al `id` en la API. |
| `name` | Nombre del título (el dado al entregarlo o el del archivo sin extensión). |
| `durationSeconds` | Duración del origen en segundos. |
| `standards`, `manifests` | Estándares generados y la ruta relativa de cada manifiesto. |
| `segmentDurationSeconds` | Duración real de los segmentos: la configurada (6 s por defecto) ajustada a un número entero de fotogramas. |
| `dynamicRange` | `source` es `sdr`, `pq` (HDR10) o `hlg`; `output` es siempre `sdr`. |
| `source` | Ruta, tamaño y características del archivo original. La ruta es la del PC de LocalProcessor-Movies. |
| `renditions[]` | Calidades publicadas. `bitrate` es el promedio medido en bps; `maxBitrate` el tope del codificador. `path` es la carpeta relativa. |
| `audioTracks[]` | Idioma en BCP-47 (`es`, `en`, `es-419`; `und` si el origen no lo indica), nombre legible, códec de salida y canales. `sourceIndex`/`sourceCodec` identifican la pista en el original. |
| `subtitleTracks[]` | Siempre `format: "vtt"`; `forced` marca los subtítulos forzados. |
| `updatedAt` | Fecha ISO-8601 de la última publicación. |

Las pistas de audio y subtítulos van también dentro de los manifiestos con sus
atributos HLS/DASH (idioma, nombre, `FORCED`, grupos por códec), de modo que un
reproductor las ofrece solo.

### 4.3 Reglas de conversión

**Video**

- Salida H.264 (perfil High), 8 bits, 4:2:0, BT.709, en todas las calidades.
- Escalera por defecto (configurable en `/config`):

  | Calidad | Caja máxima | Bitrate máximo |
  |---|---|---|
  | `2160p` | 3840 × 2160 | 16 000 kbps |
  | `1080p` | 1920 × 1080 | 6 000 kbps |
  | `720p` | 1280 × 720 | 3 000 kbps |
  | `480p` | 854 × 480 | 1 500 kbps |
  | `360p` | 640 × 360 | 800 kbps (definida, desactivada por defecto) |

- **Nunca hay upscaling**: las calidades mayores que el origen se omiten y el
  bitrate máximo de cada calidad tampoco supera el del original. Un origen
  1080p produce 1080p, 720p y 480p. Si el origen es menor que todas las
  calidades configuradas, se genera una a su tamaño real.
- El tamaño de GOP se fija a la duración del segmento (`GOP = segundos × fps`),
  para que cada segmento empiece en un fotograma clave.
- Todas las calidades se codifican en una sola pasada de ffmpeg a partir de una
  única decodificación del original.

**HDR → SDR**

- Detecta HDR por la función de transferencia del origen (`smpte2084` = HDR10/PQ,
  `arib-std-b67` = HLG) y aplica *tone-mapping* (algoritmo Hable, con el pico
  de brillo leído de los metadatos MaxCLL o de la pantalla de masterización).
- Dolby Vision con base HDR10 (perfiles 7 y 8) se trata igual. Dolby Vision
  perfil 5 (sin base HDR10) **se rechaza** al entregarlo (`400`), porque no se
  puede convertir con colores correctos.
- El resultado se señaliza como SDR (`VIDEO-RANGE=SDR` en HLS) y `metadata.json`
  lo refleja en `dynamicRange`.

**Audio**

- AAC se copia tal cual. AC-3 y E-AC-3 se copian **y además** se genera una
  versión AAC con los mismos canales, porque Chrome y Firefox no decodifican
  Dolby. Cualquier otro códec (DTS, TrueHD, FLAC, Opus…) se convierte a AAC
  conservando los canales (hasta 8) a 64 kbps por canal (128 kbps estéreo,
  384 kbps 5.1).
- En HLS cada códec de audio forma su propio grupo (`audio-aac`, `audio-ac3`…)
  y cada calidad de video tiene una variante por grupo: cada reproductor elige
  el que sabe decodificar.

**Subtítulos**

- SubRip, ASS/SSA, WebVTT y `mov_text` se convierten a WebVTT segmentado.
- Los subtítulos forzados se marcan como tales en HLS y DASH. Ningún subtítulo
  se activa por defecto salvo que el MKV de origen marque uno como *default*
  (en MP4 ese indicador se ignora porque casi siempre lo lleva la primera pista).
- Los subtítulos de imagen (PGS, VobSub, DVB) **no se convierten**: aparecen en
  `GET /titles/:id` como `subtitle_tracks` con `requiere_ocr: true` y
  `status: "pending"`, y no figuran en `metadata.json`.

### 4.4 Reprocesado

Un título publicado se puede ampliar sin rehacerlo:

- **Agregar calidad**: codifica solo la calidad nueva y la añade a los
  manifiestos.
- **Agregar pista**: extrae una pista del original que no se incluyó, o toma un
  archivo externo (`.srt`, `.ass`, `.aac`, `.ac3`…), y la añade.
- **Reprocesar completo**: rehace el título con la configuración actual.

Todo se construye en `.tmp/` y solo al terminar se publica con un *rename*.
Mientras tanto, la versión anterior sigue completa y servible.

---

## 5. Guía de integración paso a paso

Todos los ejemplos usan el mismo PC (`http://127.0.0.1:4700`). Desde otra
máquina, cambia la dirección por la IP del PC de LocalProcessor-Movies y añade
`-H 'Authorization: Bearer <token>'` a cada llamada (ver
[dirección y autenticación](#61-dirección-y-autenticación)). Los comandos
`curl` usan comillas simples: valen en bash, macOS, Linux, PowerShell 7 (con
`curl.exe`) y en Postman (*Import → Raw text*). Las rutas de Windows se pueden
escribir con barras normales (`C:/Peliculas/...`); la API devuelve las rutas
tal como las escribe el sistema operativo (en Windows, con barras invertidas).

### 5.1 Comprobar que LocalProcessor-Movies está disponible

```bash
curl http://127.0.0.1:4700/health
```

```json
{ "status": "ok", "app": "LocalProcessor-Movies", "version": "1.2.0", "uptimeSeconds": 912 }
```

Si la conexión falla, la aplicación no está abierta. Antes de entregar algo,
comprueba también que hay carpeta de salida: `GET /config` devuelve
`outputFolder` (`null` hasta que el usuario la elige; en ese estado
`POST /titles` responde `409`).

### 5.2 Entregar una película

**Opción A · Por ruta (JSON).** Para archivos que el PC de LocalProcessor-Movies puede
abrir. El archivo no se copia: se procesa desde donde está.

```bash
curl -X POST http://127.0.0.1:4700/titles -H 'Content-Type: application/json' -d '{"sourcePath": "C:/Peliculas/La pelicula.mkv", "name": "La película"}'
```

**Opción B · Subiendo el archivo (multipart).** Para clientes en otra máquina.
El archivo viaja en el campo `file` (uno por petición, sin límite de tamaño) y
se guarda en `<salida>/.uploads/<uuid>.<ext>`; LocalProcessor-Movies lo conserva para
reprocesados y lo borra junto con el título.

```bash
curl -X POST http://127.0.0.1:4700/titles -F 'file=@C:/Peliculas/La pelicula.mkv' -F 'name=La película'
```

Campos opcionales (JSON o campos de texto del formulario; las listas, separadas
por coma en multipart):

| Campo | Tipo | Descripción |
|---|---|---|
| `name` | texto | Nombre del título. Por defecto, el del archivo sin extensión. |
| `standards` | lista | `["hls", "dash"]` o un subconjunto. Por defecto, los de la configuración. |
| `qualities` | lista | Etiquetas de la escalera (`"1080p"`, `"720p"`…). Deben existir en `config.rungs`; las mayores que el origen se omiten. |
| `segmentDurationSeconds` | entero 1–60 | Duración de los segmentos. Por defecto, la de la configuración (6). |

Respuesta `201 Created`. Guarda `title.id` (identifica el título y su carpeta)
y `job.id` (para seguir el progreso):

```json
{
  "title": {
    "id": "0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60",
    "name": "La película",
    "source_path": "C:/Peliculas/La pelicula.mkv",
    "source_managed": false,
    "source_hash": "3b1f…",
    "source_width": 1920,
    "source_height": 1080,
    "source_video_bitrate": 12000000,
    "source_fps": 23.976,
    "source_video_codec": "h264",
    "source_hdr": null,
    "duration_seconds": 5400.5,
    "output_folder": "C:\\LocalProcessor-Movies\\0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60",
    "status": "queued",
    "error": null,
    "created_at": "2026-09-18T02:10:00.000Z",
    "updated_at": "2026-09-18T02:10:00.000Z"
  },
  "job": {
    "id": "6a1d9b3c-2e4f-4a5b-8c7d-9e0f1a2b3c4d",
    "title_id": "0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60",
    "tipo": "inicial",
    "status": "queued",
    "progress": 0,
    "current_step": null,
    "error": null,
    "attempts": 0,
    "config_json": "{…}",
    "created_at": "2026-09-18T02:10:00.000Z",
    "started_at": null,
    "finished_at": null
  }
}
```

La respuesta llega en cuanto el archivo queda analizado y en cola (unos
segundos); el procesado sigue en segundo plano. La configuración (calidades,
estándares, carpeta) queda congelada en el job en ese momento: cambiarla después
no afecta a lo que ya está en cola.

### 5.3 Seguir el progreso

Un job pasa por `queued → running → done`, o termina en `error` (con el motivo
en `error`) o `cancelled`. Mientras corre, `progress` va de 0 a 100 y
`current_step` indica la etapa: `probe`, `plan`, `encode`, `package`,
`publish`. El título asociado pasa por `queued → processing → done | error`.

**Por consulta** (suficiente para la mayoría de los casos; cada 2–5 s):

```bash
curl http://127.0.0.1:4700/jobs/6a1d9b3c-2e4f-4a5b-8c7d-9e0f1a2b3c4d
```

**Por WebSocket**, para no consultar en bucle. Al conectar, `ws://127.0.0.1:4700/jobs/stream`
envía `{ "type": "snapshot", "jobs": [...] }` con los jobs activos y después un
mensaje JSON por evento:

| Evento | Contenido | Cuándo |
|---|---|---|
| `job.progress` | `job` | Avance de un job en curso (`progress`, `current_step`). |
| `job.updated` | `job` | Cambio de estado: empezó, terminó, falló o se canceló. |
| `title.updated` | `title` | Cambio de estado o de datos de un título. |
| `title.deleted` | `titleId` | Un título se eliminó. |
| `job.log` | `jobId`, `line` | Líneas de ffmpeg y del empaquetador (diagnóstico). |
| `config.updated` | `config` | La configuración cambió. |
| `log.entry` | `entry` | Nueva entrada del registro de acciones (ver [6.6](#66-registro-de-acciones)). |

Desde otra máquina el token va en la URL (`?token=<token>`), porque un
WebSocket no admite cabeceras. Si el archivo es muy corto, el job puede terminar
antes de que el WebSocket conecte: tras conectar, consulta `GET /jobs/:id` una
vez (el ejemplo de [5.11](#511-ejemplo-completo-node-22-sin-dependencias) lo hace).

### 5.4 Recoger el resultado

Cuando el job termina en `done`, `title.output_folder` contiene el paquete
completo descrito en [4.1](#41-la-carpeta-de-un-título). Lee
`<output_folder>/metadata.json` para saber qué hay: manifiestos, calidades,
pistas de audio y subtítulos.

La API ofrece la misma información desde su base de datos: `GET /titles/:id`
devuelve el título con `renditions`, `audio_tracks`, `subtitle_tracks` y
`jobs`, y `GET /titles/:id/files` devuelve el árbol de archivos con tamaños
(`{ root, exists, totalBytes, fileCount, entries[] }`; las carpetas de
segmentos aparecen colapsadas como una entrada `kind: "segments"`).

### 5.5 Servir la carpeta

LocalProcessor-Movies no sirve archivos: Localcloud publica `<salida>/<uuid>/` con un
servidor de archivos estáticos y entrega al reproductor la URL del manifiesto:

```
https://localcloud.local/media/0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60/master.m3u8    HLS
https://localcloud.local/media/0f6c1c2e-8f0e-4c7b-9a3d-1b2c3d4e5f60/manifest.mpd   DASH
```

Requisitos del servidor de archivos:

| Extensión | `Content-Type` |
|---|---|
| `.m3u8` | `application/vnd.apple.mpegurl` |
| `.mpd` | `application/dash+xml` |
| `.mp4` | `video/mp4` |
| `.m4s` | `video/iso.segment` |
| `.vtt` | `text/vtt` |
| `.json` | `application/json` |

- Todas las rutas de los manifiestos son **relativas** a la carpeta del título:
  basta con servirla tal cual, sin reescribir nada.
- Si la página del reproductor está en otro origen que los archivos, añade
  `Access-Control-Allow-Origin` en el servidor de archivos.
- Caché: los segmentos (`.m4s`, `init.mp4`, `.vtt`) no cambian nunca y admiten
  `Cache-Control: public, max-age=31536000, immutable`; `master.m3u8`,
  `manifest.mpd` y `metadata.json` cambian al reprocesar, así que conviene
  `no-cache` o una caducidad corta.
- No expongas `.tmp/` ni `.uploads/` (esta última contiene los originales).

Reproductores: Safari, iOS y tvOS reproducen HLS de forma nativa; Chrome,
Firefox y Edge necesitan [hls.js](https://github.com/video-dev/hls.js) o
[Shaka Player](https://github.com/shaka-project/shaka-player); para DASH,
Shaka Player o dash.js; en Android, ExoPlayer/Media3; los Smart TV reproducen
HLS o DASH desde sus navegadores o apps. Los navegadores toman el grupo de
audio AAC; los dispositivos con Dolby pueden elegir el AC-3/E-AC-3 original.

### 5.6 Reprocesar un título

`POST /titles/:id/reprocess` encola un job incremental y responde
`202 { title, job }`. Requiere que el título no tenga otro job activo (`409`) y
que su archivo de origen siga existiendo (`400`).

```bash
# Agregar una calidad (debe existir en config.rungs y no superar al origen)
curl -X POST http://127.0.0.1:4700/titles/<id>/reprocess -H 'Content-Type: application/json' -d '{"tipo": "agregar_calidad", "qualities": ["360p"]}'

# Agregar pistas: índices de pistas del original no incluidas y/o archivos externos
curl -X POST http://127.0.0.1:4700/titles/<id>/reprocess -H 'Content-Type: application/json' -d '{"tipo": "agregar_pista", "audio": [3], "files": [{"path": "C:/Subs/la-pelicula.fr.srt", "kind": "subtitle", "language": "fr", "name": "Français", "forced": false}]}'

# Rehacer el título completo con la configuración actual (o con estos valores)
curl -X POST http://127.0.0.1:4700/titles/<id>/reprocess -H 'Content-Type: application/json' -d '{"tipo": "reprocesar_completo", "qualities": ["1080p", "720p"], "standards": ["hls"], "segmentDurationSeconds": 4}'
```

Los archivos externos de `files` llevan `path` (ruta en el PC de
LocalProcessor-Movies), `kind` (`audio` o `subtitle`) y, opcionalmente, `language`
(BCP-47), `name` y `forced`.

### 5.7 Eliminar un título

```bash
curl -X DELETE http://127.0.0.1:4700/titles/<id>
```

Responde `204`. Cancela los jobs del título, borra su carpeta de salida y, si el
original se subió por multipart, también la copia de `.uploads/`. Un archivo
entregado por ruta nunca se toca.

### 5.8 Reconstruir la biblioteca

La carpeta de salida es autodescriptiva: si la base de datos de LocalProcessor-Movies
se pierde o la carpeta cambia de sitio, `POST /titles/import` recorre
`<salida>/<uuid>/`, importa los títulos que no estén en la biblioteca y
revincula los que cambiaron de carpeta. Responde
`{ imported: Title[], relinked: Title[], skipped: [{ folder, reason }] }`. La
aplicación lo hace sola al elegir la carpeta.

Un título importado conserva su `source_path` si el original sigue en la ruta
que guarda `metadata.json`; si no, queda con `source_path: null` y no se puede
reprocesar hasta vincularlo con `PUT /titles/:id/source { "sourcePath" }`
(se comprueba con ffprobe que la duración coincida).

### 5.9 Errores

Toda respuesta de error tiene el cuerpo `{ "statusCode", "error", "message" }`
(mensajes en español), a veces con campos adicionales.

| Código | Cuándo | Campos extra |
|---|---|---|
| `400` | `sourcePath` ausente o relativo; el archivo no existe o no es un archivo; ffprobe no pudo analizarlo; Dolby Vision perfil 5; no hay espacio suficiente; `qualities`/`standards`/`segmentDurationSeconds` inválidos; en multipart falta `file` o hay más de uno; al reprocesar, el original ya no existe. | `problems[]` (configuración), `requiredBytes`/`freeBytes` (espacio) |
| `401` | Desde la red, sin token o con un token incorrecto. | |
| `403` | Desde la red con el acceso en modo local. | |
| `404` | Título o job inexistente. | |
| `409` | El archivo ya está registrado; la carpeta de salida no está configurada o ya no existe; el título tiene un job en curso; el título no tiene archivo de origen; el job ya terminó (al cancelar); la ruta de `PUT /titles/:id/source` pertenece a otro título. | `titleId` |

### 5.10 Tiempos y espacio

Referencias medidas en un PC con Ryzen 5 7600 y GeForce RTX 4060 (NVENC), con
la escalera por defecto:

| Origen | Velocidad | Película de 2 h |
|---|---|---|
| 4K SDR | ≈ 2× tiempo real | ≈ 1 h |
| 4K HDR (con *tone-mapping*, en CPU) | ≈ 1× tiempo real | ≈ 2 h |

Un origen 1080p va bastante más rápido (una cuarta parte de los píxeles y una
calidad menos). Sin GPU (libx264), cuenta varias veces el tiempo real. Los jobs
se ejecutan en paralelo según el hardware (`GET /system` → `concurrency`).

Espacio: la carpeta de un título ocupa como máximo la suma de los bitrates de
sus calidades por la duración (con los valores por defecto y un origen 4K,
hasta ≈ 12 GB por hora; menos en la práctica, porque los bitrates son topes).
Antes de encolar se comprueba que haya espacio para el trabajo, incluida la
carpeta temporal, que vive en el mismo disco.

### 5.11 Ejemplo completo (Node 22, sin dependencias)

```js
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:4700'

// Entrega una película y espera a que esté publicada. Devuelve la carpeta y su metadata.json.
export async function procesarPelicula(sourcePath, name) {
  const res = await fetch(`${BASE}/titles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath, name })
  })
  if (!res.ok) throw new Error((await res.json()).message)
  const { title, job } = await res.json()

  await esperarJob(job.id)

  const metadata = JSON.parse(await readFile(join(title.output_folder, 'metadata.json'), 'utf8'))
  return { titleId: title.id, folder: title.output_folder, metadata }
}

const TERMINADO = ['done', 'error', 'cancelled']

function esperarJob(jobId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/jobs/stream`)
    const terminar = (job) => {
      ws.close()
      if (job.status === 'done') resolve(job)
      else reject(new Error(job.error ?? `job ${job.status}`))
    }
    ws.onopen = async () => {
      // Por si el job terminó antes de conectar
      const job = await (await fetch(`${BASE}/jobs/${jobId}`)).json()
      if (TERMINADO.includes(job.status)) terminar(job)
    }
    ws.onmessage = ({ data }) => {
      const event = JSON.parse(data)
      if (event.type === 'job.progress' && event.job.id === jobId) console.log(`${event.job.current_step} ${event.job.progress}%`)
      if (event.type === 'job.updated' && event.job.id === jobId && TERMINADO.includes(event.job.status)) terminar(event.job)
    }
    ws.onerror = () => reject(new Error('sin conexión con LocalProcessor-Movies'))
  })
}
```

---

## 6. Referencia de la API

### 6.1 Dirección y autenticación

- Por defecto la API escucha solo en `127.0.0.1:4700` y no pide autenticación a
  los programas de la misma máquina.
- Con *Permitir acceso desde la red local* (o `PUT /config { "apiAccess": "lan" }`)
  escucha en `0.0.0.0` y exige a las demás máquinas un token de 32 caracteres
  que genera la aplicación (visible en *Configuración* y en la sección *API*).
  Se envía como `Authorization: Bearer <token>` o `X-Api-Key: <token>`; en el
  WebSocket también como `?token=<token>`. `POST /config/api-token` genera uno
  nuevo y revoca el anterior.
- `GET /system` indica dónde está escuchando (`listening`) y las IPs del equipo
  (`lanAddresses`).
- El puerto se cambia con la variable de entorno `LP_API_PORT` al lanzar la
  aplicación.
- La sección **API** de la aplicación genera los comandos `curl` exactos (con
  la dirección y el token que correspondan) para pegar en Postman o en una
  terminal.

### 6.2 Endpoints

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| `POST` | `/titles` | JSON `{ sourcePath, name?, standards?, qualities?, segmentDurationSeconds? }` o multipart con `file` y los mismos campos | `201 { title, job }` |
| `GET` | `/titles` | — | `200 Title[]` |
| `GET` | `/titles/:id` | — | `200 Title` con `renditions[]`, `audio_tracks[]`, `subtitle_tracks[]`, `jobs[]` |
| `GET` | `/titles/:id/files` | — | `200 { root, exists, totalBytes, fileCount, entries[] }` |
| `POST` | `/titles/:id/reprocess` | `{ tipo: "agregar_calidad", qualities }`, `{ tipo: "agregar_pista", audio?, subtitles?, files? }` o `{ tipo: "reprocesar_completo", standards?, qualities?, segmentDurationSeconds? }` | `202 { title, job }` |
| `PUT` | `/titles/:id/source` | `{ sourcePath }` | `200 Title` |
| `DELETE` | `/titles/:id` | — | `204` |
| `POST` | `/titles/import` | — | `200 { imported[], relinked[], skipped[] }` |
| `GET` | `/jobs` | `?status=queued,running` (por defecto, los activos) o `?status=all` | `200 Job[]` |
| `GET` | `/jobs/:id` | — | `200 Job` |
| `GET` | `/jobs/:id/log` | — | `200 text/plain` con la salida completa de ffmpeg y del Packager del job (`404` si no la hay) |
| `POST` | `/jobs/:id/cancel` | — | `202 Job` |
| `WS` | `/jobs/stream` | — | `snapshot` y luego un evento JSON por mensaje |
| `GET` | `/config` | — | `200 Config` |
| `PUT` | `/config` | Solo los campos a cambiar | `200 Config` |
| `POST` | `/config/api-token` | — | `200 Config` con el token nuevo |
| `GET` | `/system` | — | `200 { platform, cpuThreads, encoders[], selectedEncoder, concurrency, listening, lanAddresses }` |
| `GET` | `/health` | — | `200 { status, app, version, uptimeSeconds }` |
| `GET` | `/logs` | `?level=&category=&jobId=&titleId=&q=&before=&limit=&format=` | `200 LogEntry[]` (o `text/plain` con `format=text`) |

### 6.3 Objetos

**Title** — un archivo entregado y su carpeta publicada.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | uuid | Identificador; nombre de la carpeta de salida. |
| `name` | texto | Nombre del título. |
| `source_path` | texto o `null` | Ruta del original en el PC de LocalProcessor-Movies; `null` en títulos importados sin origen. |
| `source_managed` | booleano | `true` si el original se subió por multipart (LocalProcessor-Movies lo borra con el título). |
| `source_hash` | texto o `null` | Huella del original, para detectar cambios entre reprocesados. |
| `source_width`, `source_height`, `source_fps`, `source_video_bitrate`, `source_video_codec` | — | Características del original. |
| `source_hdr` | `null`, `"pq"` o `"hlg"` | Rango dinámico del original (la salida es siempre SDR). |
| `duration_seconds` | número | Duración. |
| `output_folder` | texto | Carpeta publicada (`<salida>/<id>`). |
| `status` | `queued`, `processing`, `done`, `error` | `done` = carpeta publicada y consistente. |
| `error` | texto o `null` | Motivo del último fallo. |
| `created_at`, `updated_at` | ISO-8601 | |

**Job** — un trabajo de la cola.

| Campo | Tipo | Descripción |
|---|---|---|
| `id`, `title_id` | uuid | |
| `tipo` | `inicial`, `agregar_calidad`, `agregar_pista`, `reprocesar_completo` | |
| `status` | `queued`, `running`, `done`, `error`, `cancelled` | |
| `progress` | 0–100 | |
| `current_step` | `probe`, `plan`, `encode`, `package`, `publish` o `null` | Etapa en curso. |
| `error` | texto o `null` | |
| `attempts` | entero | Reintentos (un fallo del codificador por hardware se reintenta en CPU). |
| `config_json` | texto | Configuración congelada al encolar. |
| `created_at`, `started_at`, `finished_at` | ISO-8601 o `null` | |

**Rendition** (`renditions[]` de `GET /titles/:id`): `label`, `width`,
`height`, `bitrate` (promedio medido, bps), `video_codec`, `status`.

**AudioTrack** (`audio_tracks[]`): `source_index` (negativo en pistas de
archivos externos), `source_path`, `language`, `title`, `codec_origen`,
`codec_salida`, `channels`, `status`.

**SubtitleTrack** (`subtitle_tracks[]`): `source_index`, `source_path`,
`language`, `title`, `formato_origen`, `formato_salida` (`vtt` o `null`),
`requiere_ocr`, `status` (`pending` en subtítulos de imagen).

Estos registros tienen su propio `id` interno; el enlace con las carpetas de
`metadata.json` es `source_index` + idioma + códec.

**LogEntry** (`GET /logs`, evento `log.entry`): `id` (entero creciente), `ts`
(ISO-8601), `level` (`debug`, `info`, `warn`, `error`), `category` (`app`,
`api`, `config`, `titles`, `jobs`, `pipeline`), `message`, `job_id`,
`title_id` y `context` (objeto con el detalle: rutas, tamaños, comandos, el
error con su traza y las últimas líneas de ffmpeg cuando un job falla).

### 6.4 Configuración

`GET /config` devuelve el objeto completo; `PUT /config` acepta cualquier
subconjunto de campos y responde `400` con `problems[]` si algo no es válido.

| Campo | Por defecto | Reglas |
|---|---|---|
| `outputFolder` | `null` | Ruta absoluta de una carpeta existente. |
| `standards` | `["hls", "dash"]` | Al menos uno. |
| `qualities` | `["2160p", "1080p", "720p", "480p"]` | Etiquetas activas; cada una debe existir en `rungs`. |
| `rungs` | ver [4.3](#43-reglas-de-conversión) | `{ "<etiqueta>": { width, height, maxBitrateKbps } }`; dimensiones pares ≥ 16. |
| `segmentDurationSeconds` | `6` | Entero entre 1 y 60. |
| `encoder` | `"auto"` | `"auto"` (mejor codificador por hardware disponible) o `"software"` (siempre libx264). |
| `maxConcurrentJobs` | `"auto"` | `"auto"` o entero 1–16. |
| `apiAccess` | `"local"` | `"local"` o `"lan"`. |
| `apiToken` | `null` | Solo lectura: lo genera la aplicación al activar `lan` y con `POST /config/api-token`. |

Los cambios se aplican a los jobs que se encolen a partir de ese momento.

### 6.5 Variables de entorno

| Variable | Efecto |
|---|---|
| `LP_API_PORT` | Puerto de la API (por defecto `4700`). |
| `LP_DATA_DIR` | Carpeta de la base de datos (por defecto, la carpeta de datos del usuario). |
| `LP_FFMPEG`, `LP_FFPROBE`, `LP_PACKAGER` | Rutas a binarios propios en lugar de los incluidos. |

### 6.6 Registro de acciones

Todo lo que la aplicación hace queda registrado, con detalle suficiente para
reconstruir qué ocurrió cuando algo falla:

| Categoría | Qué registra |
|---|---|
| `app` | Arranque (versión, carpeta de datos, binarios, codificadores detectados y por qué no está disponible cada uno), migraciones, dirección en la que escucha la API, cierre, excepciones no capturadas. |
| `api` | Cada petición que cambia algo (método, ruta, IP, resultado, duración y cuerpo, sin el token) y cada petición rechazada, con el motivo. Las consultas `GET` correctas no se registran. |
| `config` | Cada campo cambiado, con el valor anterior y el nuevo; el token nunca se escribe. |
| `titles` | Título creado, archivo subido, importación de la carpeta, origen vinculado, título eliminado (con las rutas). |
| `jobs` | Encolado, inicio (codificador, intento), cada paso con su duración, avance cada 10 % (`debug`), fin con carpeta y tamaño, cancelación, reintento por software, reencolado tras un cierre inesperado; los fallos llevan el paso, el error con su traza, el código de salida y las últimas 200 líneas de ffmpeg. |
| `pipeline` | Lo que ffprobe encontró (pistas, HDR, bitrate), el plan (calidades generadas y omitidas con el motivo, pistas copiadas o convertidas, subtítulos descartados), los comandos exactos de ffmpeg y del Packager (`debug`), lo codificado con sus tamaños y lo publicado. |

La sección **Logs** de la aplicación muestra el mismo registro en tiempo real,
con filtros por nivel, categoría, texto, job o título (*Ver logs* desde *Jobs*
y desde la ficha del título), el detalle de cada entrada desplegable, la salida
completa de ffmpeg de cada job, exportación a texto y acceso a la carpeta de
logs.

`GET /logs` devuelve las entradas más recientes que cumplen el filtro, en orden
cronológico: `level` es el nivel mínimo (`info` por defecto en la interfaz;
`debug` incluye comandos y avance), `category`, `jobId` y `titleId` acotan,
`q` busca en el mensaje y el contexto, `before=<id>` pagina hacia el pasado y
`limit` (1–1000, 200 por defecto) fija el tamaño. `format=text` entrega las
mismas líneas que `app.log`. La tabla conserva las últimas 50 000 entradas; el
WebSocket emite cada entrada nueva como `log.entry`.

---

## 7. Desarrollo

Requisitos: Node.js 22+ y npm.

```bash
npm install          # instala dependencias y descarga Electron
npm run fetch-bins   # descarga ffmpeg, ffprobe y Shaka Packager a resources/bin/
npm run dev          # Electron + Vite con recarga en caliente
npm test             # unitarios + integración real (usa los binarios descargados)
npm run typecheck
```

Herramientas de línea de comandos para probar el pipeline sin la interfaz:

```bash
npm run make-sample                                      # clip sintético en samples/ (--hdr para uno HDR10)
npm run process -- samples/sample.mkv --out C:/salida    # pipeline completo por CLI
```

La interfaz también se puede abrir en un navegador en `http://localhost:5173`
mientras `npm run dev` está corriendo (sin los diálogos nativos de archivos).
Una instancia en desarrollo necesita el puerto 4700 libre: cierra la aplicación
instalada antes.

Estructura del código:

```
src/main/       proceso principal de Electron: ventana, arranque del servidor, diálogos nativos
src/renderer/   interfaz React (secciones Biblioteca, Cola, Configuración, API…)
src/server/     Fastify: rutas, base de datos SQLite (migraciones, repositorios), cola y runner de jobs
src/pipeline/   probe → plan → encode (ffmpeg) → package (Shaka Packager) → publish; metadata.json
src/shared/     tipos y configuración compartidos entre procesos (contrato de la API)
scripts/        fetch-bins, make-sample, process (CLI)
docs/           documentación funcional y técnica
```

---

## 8. Instaladores y versiones

```bash
npm run dist         # instalador para el sistema actual, en dist/
npm run dist:dir     # solo la carpeta desempaquetada (dist/*-unpacked)
```

Cada plataforma se construye en su propio sistema operativo. El flujo de GitHub
Actions (`.github/workflows/release.yml`) genera los tres instaladores y los
adjunta a un *release* al publicar un tag `v*`:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

Los instaladores no están firmados y la aplicación no se actualiza sola: para
pasar a una versión nueva se instala el instalador nuevo encima (la base de
datos y la configuración se conservan).

---

## 9. Licencias

Código bajo licencia [MIT](LICENSE). Los binarios de ffmpeg/x264 (GPL) y Shaka
Packager (BSD) incluidos en el instalador se detallan en
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
