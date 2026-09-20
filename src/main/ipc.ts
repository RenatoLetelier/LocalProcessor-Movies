import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Repositories } from '@server/db/repositories'

const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'm2ts', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', 'ogv']
const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt']
const AUDIO_EXTENSIONS = ['mka', 'm4a', 'aac', 'ac3', 'eac3', 'mp3', 'flac', 'wav', 'opus', 'ogg', 'dts', 'wma']

export function registerIpcHandlers(apiBaseUrl: string, repos: Repositories, logsDir: string): void {
  ipcMain.handle('app:api-base-url', () => apiBaseUrl)

  ipcMain.handle('shell:open-logs-folder', async () => {
    await shell.openPath(logsDir)
  })

  ipcMain.handle('dialog:save-text-file', async (event, suggestedName: unknown, content: unknown) => {
    if (typeof suggestedName !== 'string' || typeof content !== 'string') return null
    const owner = ownerOf(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: 'Guardar registro',
      defaultPath: join(app.getPath('downloads'), suggestedName),
      filters: [
        { name: 'Texto', extensions: ['txt', 'log'] },
        { name: 'Todos los archivos', extensions: ['*'] }
      ]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, content, 'utf8')
    return result.filePath
  })

  ipcMain.handle('dialog:pick-video-files', async (event) => {
    const owner = ownerOf(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Elegir películas',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'Todos los archivos', extensions: ['*'] }
      ]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:pick-track-files', async (event, kind: unknown) => {
    const owner = ownerOf(event.sender)
    const subtitle = kind === 'subtitle'
    const options: Electron.OpenDialogOptions = {
      title: subtitle ? 'Elegir subtítulos' : 'Elegir pistas de audio',
      properties: ['openFile', 'multiSelections'],
      filters: [
        subtitle ? { name: 'Subtítulos', extensions: SUBTITLE_EXTENSIONS } : { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'Todos los archivos', extensions: ['*'] }
      ]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:pick-folder', async (event, defaultPath?: unknown) => {
    const owner = ownerOf(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Elegir carpeta de salida',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Only folders inside the configured output folder can be opened from the UI
  ipcMain.handle('shell:open-folder', async (_event, path: unknown) => {
    const outputFolder = repos.settings.getConfig().outputFolder
    if (typeof path !== 'string' || !outputFolder) return
    const target = resolve(path)
    const root = resolve(outputFolder)
    if (target !== root && !target.startsWith(root + sep)) return
    await shell.openPath(target)
  })
}

function ownerOf(sender: Electron.WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined
}
