import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppBridge } from '@shared/bridge'

const bridge: AppBridge = {
  getApiBaseUrl: () => ipcRenderer.invoke('app:api-base-url'),
  pickVideoFiles: () => ipcRenderer.invoke('dialog:pick-video-files'),
  pickTrackFiles: (kind) => ipcRenderer.invoke('dialog:pick-track-files', kind),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  openFolder: (path) => ipcRenderer.invoke('shell:open-folder', path),
  openLogsFolder: () => ipcRenderer.invoke('shell:open-logs-folder'),
  saveTextFile: (suggestedName, content) => ipcRenderer.invoke('dialog:save-text-file', suggestedName, content),
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('app', bridge)
