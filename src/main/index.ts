import { app, BrowserWindow, dialog, Menu } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { FastifyInstance } from 'fastify'
import { join } from 'node:path'
import type { AppConfig } from '@shared/config'
import { APP_NAME, DEFAULT_API_HOST, DEFAULT_API_PORT, LAN_API_HOST } from '@shared/constants'
import { startServer, type ServerOptions } from '@server/index'
import { DB_FILE_NAME, openDatabase, type AppDatabase } from '@server/db'
import { ServerEvents } from '@server/jobs/events'
import { JobRunner } from '@server/jobs/runner'
import { FileSink } from '@server/logging/file-sink'
import { JobOutputStore } from '@server/logging/job-output'
import { AppLogger, errorContext } from '@server/logging/logger'
import { resolveBinaries } from '@pipeline/binaries'
import { detectHardware } from '@pipeline/hardware'
import { adoptLegacyDataDir } from './data-dir'
import { createMainWindow, rendererOrigin } from './window'
import { registerIpcHandlers } from './ipc'
import { buildRendererCsp, registerRendererScheme, serveRenderer } from './renderer-protocol'

// The UI always talks to the loopback address, whatever the bind host is
const apiPort = Number(process.env.LP_API_PORT) || DEFAULT_API_PORT
const apiBaseUrl = `http://${DEFAULT_API_HOST}:${apiPort}`

let database: AppDatabase | undefined
let server: FastifyInstance | undefined
let runner: JobRunner | undefined
let log: AppLogger | undefined
let shuttingDown = false

// One running instance: the API port is fixed and SQLite has a single writer
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  registerRendererScheme()

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    void shutdown().finally(() => app.quit())
  })

  app.whenReady().then(main).catch(fatal)
}

async function main(): Promise<void> {
  electronApp.setAppUserModelId('com.localprocessor.movies')
  setupMenu()

  const dataDir = process.env.LP_DATA_DIR || app.getPath('userData')
  const logsDir = join(dataDir, 'logs')
  // The text log exists before anything else can fail; the table joins once the database is open
  log = new AppLogger({ file: new FileSink(join(logsDir, 'app.log')), echo: is.dev ? (line) => console.log(line) : undefined })
  log.info('app', `Arrancando ${APP_NAME} ${app.getVersion()}`, {
    context: { dataDir, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, dev: is.dev }
  })
  process.on('uncaughtException', (error) => log?.error('app', `Excepción no capturada: ${error.message}`, { context: errorContext(error) }))
  process.on('unhandledRejection', (reason) => {
    log?.error('app', `Promesa rechazada sin capturar: ${reason instanceof Error ? reason.message : String(reason)}`, { context: errorContext(reason) })
  })

  const adopted = !process.env.LP_DATA_DIR && adoptLegacyDataDir(dataDir)
  if (adopted) log.warn('app', 'Base de datos copiada desde la carpeta de LocalProcessor 1.0 (primer arranque con el nombre nuevo)', { context: { dataDir } })
  database = openDatabase(join(dataDir, DB_FILE_NAME))
  const events = new ServerEvents()
  log.attachStore(database.repos.logs, events)
  if (database.migrationsApplied.length > 0) {
    log.info('app', `Migraciones de la base de datos aplicadas: ${database.migrationsApplied.join(', ')}`, { context: { versions: database.migrationsApplied } })
  }
  const jobOutput = new JobOutputStore(join(logsDir, 'jobs'))
  const prunedOutputs = jobOutput.prune()
  if (prunedOutputs > 0) log.debug('app', `Salidas de ffmpeg antiguas eliminadas: ${prunedOutputs}`, { context: { dir: jobOutput.dir } })

  const resourcesDir = is.dev ? join(app.getAppPath(), 'resources') : process.resourcesPath
  const binaries = resolveBinaries({ resourcesDir })
  log.info('app', 'Binarios localizados', { context: { ...binaries } })

  // A one-second test encode per candidate: what ffmpeg lists is not what the drivers can do
  const hardware = await detectHardware(binaries)
  const available = hardware.encoders.filter((e) => e.available)
  log.info('app', `Codificadores disponibles: ${available.map((e) => e.label).join(', ') || 'ninguno'}; se usará ${hardware.encoders.find((e) => e.kind === hardware.preferred)?.label ?? hardware.preferred}`, {
    context: { platform: hardware.platform, cpuThreads: hardware.cpuThreads, preferred: hardware.preferred, encoders: hardware.encoders }
  })

  runner = new JobRunner({ db: database.db, repos: database.repos, events, binaries, hardware, log, jobOutput })
  const serverOptions: Omit<ServerOptions, 'host'> = {
    port: apiPort,
    version: app.getVersion(),
    context: { db: database.db, repos: database.repos, events, runner, log, jobOutput, binaries, hardware },
    allowedOrigins: [rendererOrigin()],
    logLevel: is.dev ? 'info' : 'warn'
  }
  const listener = new ApiListener(serverOptions)
  server = await listener.start(apiHostFor(database.repos.settings.getConfig()))
  events.subscribe((event) => {
    if (event.type === 'config.updated') listener.switchTo(apiHostFor(event.config))
  })

  serveRenderer(join(__dirname, '../renderer'), buildRendererCsp(apiBaseUrl))
  registerIpcHandlers(apiBaseUrl, database.repos)
  app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window))

  openWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
  runner.start()
}

function apiHostFor(config: AppConfig): string {
  return config.apiAccess === 'lan' ? LAN_API_HOST : DEFAULT_API_HOST
}

// A bound HTTP server cannot change address, so enabling or disabling LAN access
// closes the Fastify instance and starts a fresh one on the new host. The runner
// and the database are untouched; the UI reconnects its WebSocket by itself.
class ApiListener {
  private host: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: Omit<ServerOptions, 'host'>) {}

  async start(host: string): Promise<FastifyInstance> {
    server = await startServer({ ...this.options, host })
    this.host = host
    log?.info('app', `API escuchando en ${host}:${apiPort}${host === LAN_API_HOST ? ' (acceso desde la red local activado)' : ''}`, { context: { host, port: apiPort } })
    return server
  }

  switchTo(host: string): void {
    this.queue = this.queue
      .then(async () => {
        if (host === this.host || shuttingDown) return
        // Let the reply that carried the config change go out first
        await new Promise((resolve) => setImmediate(resolve))
        const previous = server
        server = undefined
        await previous?.close()
        try {
          await this.start(host)
        } catch (error) {
          log?.error('app', `No se pudo escuchar en ${host}:${apiPort}; la API sigue solo en ${DEFAULT_API_HOST}`, { context: { host, ...errorContext(error) } })
          await this.start(DEFAULT_API_HOST)
        }
      })
      .catch((error: unknown) => log?.error('app', 'No se pudo cambiar la dirección de la API', { context: errorContext(error) }))
  }
}

function openWindow(): void {
  const win = createMainWindow()
  win.on('close', (event) => {
    if (shuttingDown || !runner?.hasRunning()) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Salir', 'Seguir procesando'],
      defaultId: 1,
      cancelId: 1,
      title: APP_NAME,
      message: 'Hay un job en curso.',
      detail: 'Si sales ahora se interrumpe y se reanudará desde cero la próxima vez que abras la aplicación.'
    })
    if (choice === 1) event.preventDefault()
  })
}

async function shutdown(): Promise<void> {
  log?.info('app', 'Cerrando la aplicación', { context: { runningJobs: runner?.hasRunning() ?? false } })
  await runner?.stop()
  await server?.close()
  database?.close()
}

function setupMenu(): void {
  // macOS needs an app menu for Cmd+Q / copy-paste; elsewhere there is no menu bar at all
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }
}

function fatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  log?.error('app', `No se pudo iniciar la aplicación: ${message}`, { context: errorContext(error) })
  dialog.showErrorBox(APP_NAME, `No se pudo iniciar la aplicación:\n\n${message}`)
  app.exit(1)
}
