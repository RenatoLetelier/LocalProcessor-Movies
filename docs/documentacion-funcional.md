# Documentación Funcional — Motor de Transcodificación VOD

**Estado:** v1 implementada
**Nombre del proyecto:** LocalProcessor-Movies

---

## 1. Resumen

Programa de escritorio (Windows/Mac/Linux) que se instala como cualquier aplicación normal, con una interfaz gráfica al estilo Docker Desktop (sidebar de navegación a la izquierda, panel de configuración/contenido a la derecha, sin ventana de navegador). Su función es tomar archivos de video (películas en `.mp4`, `.mkv`, `.avi`, etc.), procesarlos y dejarlos listos como una carpeta de streaming adaptativo (HLS y/o DASH), para que **otro programa** (por ejemplo, LocalCloud) los sirva a los usuarios finales.

No es un reproductor ni una plataforma de streaming en sí mismo — es el motor de conversión que se para en el medio entre "tengo un archivo de video" y "tengo una carpeta lista para streaming".

## 2. Objetivo final

> Seleccionar una o varias películas → pasárselas al programa (por ruta local o por API en localhost) → obtener como resultado una carpeta por película, con todas las calidades de video, pistas de audio y pistas de subtítulos, lista para que otro sistema la sirva por streaming.

## 3. Alcance funcional (v1)

### 3.1 Instalación y UI
- Instalable en el sistema operativo del usuario (no requiere Docker, no requiere dependencias externas como Redis — todo viene empaquetado).
- Interfaz nativa de escritorio, no basada en navegador visible para el usuario. Estilo Docker Desktop: sidebar de navegación + panel principal.
- Al abrir por primera vez, solicita al usuario que defina la carpeta de salida (output).

### 3.2 Ingesta de contenido
- Selector de archivo(s) local(es) desde la UI (uno o varios a la vez).
- API local (HTTP, en `127.0.0.1`) para que otros programas puedan enviar un archivo o una ruta local y encolarlo para procesamiento, sin pasar por la UI. Opcionalmente puede habilitarse el acceso desde otras máquinas de la red local, protegido con un token que genera la aplicación.

### 3.3 Configuración de procesado
- Selección del estándar de salida: HLS, DASH, o ambos a la vez.
- Selección de las calidades finales a generar (ej. 1080p, 720p, 480p), configurable por el usuario.
- Configuración de la duración de los segmentos/chunks (por defecto 6 segundos, siguiendo la recomendación de Apple para HLS, pero ajustable).

### 3.4 Motor de transcodificación
- Analiza el archivo de origen antes de procesar (resolución, bitrate, pistas de audio y subtítulos disponibles).
- Genera únicamente las calidades configuradas que sean **iguales o menores** a la calidad de origen (nunca upscaling).
- Preserva la calidad de video y audio del original — no degrada más de lo necesario para hacer el contenido compatible con streaming.
- Preserva todas las pistas de audio y de subtítulos del archivo original.
- Los orígenes HDR (HDR10/PQ o HLG, habituales en 4K) se convierten a SDR mediante *tone-mapping*, de modo que el resultado se ve con colores correctos en cualquier reproductor, tenga o no soporte HDR. Las fuentes Dolby Vision con base HDR10 (perfiles 7 y 8) se tratan igual; las de perfil 5, sin base HDR10, se rechazan al encolar porque no se pueden convertir con colores correctos. Conservar el HDR en una escalera HEVC adicional queda como extensión futura.
- Si un códec de audio no es compatible con streaming (ej. DTS), se transcodifica a AAC o EAC3 en vez de descartarlo.
- Subtítulos de imagen (PGS, VobSub) requieren conversión a texto (OCR) o quemado en video — a definir cuál enfoque por defecto.

### 3.5 Empaquetado
- El resultado se organiza en una carpeta por título, con subcarpetas por calidad y un manifiesto raíz (`master.m3u8` y/o `.mpd` según configuración).
- Se genera un archivo adicional `metadata.json` por título, con la lista de calidades, pistas de audio (idioma, códec) y pistas de subtítulos (idioma, formato) disponibles — para que un sistema externo no necesite parsear el manifiesto de streaming para saber qué contenido hay disponible.
- La carpeta de salida es recuperable: al elegirla (primer arranque o cambio en Configuración) y con *Buscar títulos en la carpeta* en la Biblioteca, el programa importa los títulos publicados que encuentre (`<uuid>/metadata.json` válido) y revincula los que se movieron de sitio. Un título importado de una carpeta antigua no conoce su archivo original; *Vincular archivo de origen* lo recupera (se comprueba que la duración coincida) y vuelve a permitir reprocesarlo.

### 3.6 Gestión de jobs
- Vista en tiempo real de los jobs: cuál está activo (con progreso) y cuáles están en cola.
- Los jobs se procesan de forma asíncrona; el usuario puede seguir usando la UI mientras se procesan.
- La cantidad de jobs simultáneos se ajusta según el hardware disponible en la máquina (aceleración por GPU si existe, o límite razonable por CPU si no).

### 3.7 Navegación de resultados
- Explorador de la carpeta de salida integrado en la UI, para ver qué títulos existen y qué contiene cada uno.

### 3.8 Reprocesado
- Permite agregar una calidad nueva a un título ya procesado, sin rehacer las calidades existentes.
- Permite agregar una pista de audio o subtítulo nueva a un título ya procesado.
- Permite reprocesar un título completo si el resultado original quedó mal.
- El reprocesado nunca interrumpe la disponibilidad del contenido ya generado — un consumidor externo (ej. alguien viendo la película) nunca debería notar que se está reprocesando.

### 3.9 Registro de actividad (logs)
- Todo lo que hace el programa queda registrado y se muestra en la sección **Logs**, en tiempo real: cada petición que cambia algo (y cada rechazo, con el motivo), cada cambio de configuración, cada acción sobre un título y el ciclo de vida completo de cada job — encolado, inicio, codificador elegido, duración de cada paso, resultado — además de lo que el pipeline encontró y decidió (pistas, HDR, calidades generadas y omitidas con el motivo, comandos ejecutados, tamaños).
- Un fallo se registra con detalle suficiente para entender exactamente qué ocurrió: paso en el que falló, error con su traza, código de salida y las últimas líneas de ffmpeg; la salida completa de ffmpeg y del empaquetador de cada job se conserva aparte y se puede abrir desde la propia entrada, desde *Jobs* o desde la ficha del título.
- La vista se filtra por nivel (info por defecto; debug muestra comandos y avance), categoría, texto, y por job o título (*Ver logs* desde *Jobs* y desde la Biblioteca). Se puede pausar, exportar a texto y abrir la carpeta de logs.
- El registro persiste (base de datos y un archivo `app.log` con rotación) con una retención de 7 días y los últimos 100 jobs, y también se consulta por la API.

## 4. Fuera de alcance (v1)

- DRM / cifrado de contenido.
- Streaming en vivo (esto es exclusivamente para VOD — contenido pregrabado).
- Multiusuario / permisos dentro del programa (es una herramienta de uso personal/local).
- Distribución del contenido (eso lo hace "el otro programa", no este).
- Generación de miniaturas/sprites de previsualización (posible extensión futura, no v1).

## 5. Reglas de negocio

1. Nunca generar una calidad superior a la resolución o bitrate del archivo de origen (no upscaling).
2. Nunca reducir la calidad de audio por debajo del original salvo que sea estrictamente necesario para compatibilidad de códec.
3. Todas las pistas de audio y subtítulos del origen deben preservarse en la salida (traducidas de formato si es necesario, nunca descartadas silenciosamente).
4. El reprocesado es siempre incremental: solo se genera lo que falta, nunca se regenera lo que ya existe y sigue siendo válido.
5. El contenido ya publicado (manifiesto + segmentos) debe seguir siendo accesible y consistente en todo momento, incluso mientras se reprocesa.

## 6. Flujo de uso (usuario)

1. Usuario abre el programa por primera vez → define carpeta de salida.
2. Usuario configura: estándar de salida (HLS/DASH/ambos), calidades deseadas, duración de segmento.
3. Usuario selecciona uno o varios archivos de película desde la UI (o los envía por la API local desde otro programa).
4. El/los archivo(s) entran a la cola de jobs. La UI muestra el progreso en tiempo real.
5. Al terminar, la carpeta de salida contiene una subcarpeta por título, lista para ser consumida por otro sistema de streaming.
6. Si el usuario necesita agregar una calidad, corregir un error o sumar una pista nueva, lo hace desde la UI (sección de reprocesado) sin tener que volver a procesar todo el título desde cero.

## 7. Glosario

- **HLS (HTTP Live Streaming):** estándar de Apple para streaming adaptativo, basado en archivos `.m3u8` y segmentos.
- **DASH (Dynamic Adaptive Streaming over HTTP):** estándar equivalente a HLS, más usado fuera del ecosistema Apple, basado en archivos `.mpd`.
- **CMAF:** formato de empaquetado común que permite generar los mismos segmentos de video para servir tanto HLS como DASH sin duplicar el contenido.
- **Rendition:** cada una de las variantes de calidad (resolución/bitrate) generadas de un mismo video.
- **Manifiesto:** archivo raíz que describe las renditions disponibles y cómo acceder a sus segmentos (`master.m3u8` o `.mpd`).
- **Segmento/chunk:** fragmento corto de video (por defecto 6s) en el que se divide cada rendition para streaming.
- **Reprocesado incremental:** generar solo el contenido nuevo (calidad, pista) sin rehacer lo que ya existe.
