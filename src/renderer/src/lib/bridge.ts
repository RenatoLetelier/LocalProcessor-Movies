import type { AppBridge } from '@shared/bridge'
import { DEFAULT_API_HOST, DEFAULT_API_PORT } from '@shared/constants'

// Outside Electron (the renderer opened in a plain browser during development)
// there is no preload: talk to the default API address and disable native dialogs.
const browserFallback: AppBridge = {
  getApiBaseUrl: async () => `http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT}`,
  pickVideoFiles: async () => [],
  pickTrackFiles: async () => [],
  pickFolder: async () => null,
  openFolder: async () => undefined,
  openLogsFolder: async () => undefined,
  // A plain download stands in for the native save dialog
  saveTextFile: async (suggestedName, content) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = suggestedName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return suggestedName
  },
  pathForFile: (file) => file.name
}

export const bridge: AppBridge = typeof window !== 'undefined' && window.app ? window.app : browserFallback
export const isElectron = typeof window !== 'undefined' && Boolean(window.app)
