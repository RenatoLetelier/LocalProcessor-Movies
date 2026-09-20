// Contract between preload (implements) and renderer (consumes) via window.app
export interface AppBridge {
  getApiBaseUrl(): Promise<string>
  // Native dialogs; empty array / null when the user cancels
  pickVideoFiles(): Promise<string[]>
  // Subtitle or audio files to attach to an existing title
  pickTrackFiles(kind: 'audio' | 'subtitle'): Promise<string[]>
  pickFolder(defaultPath?: string): Promise<string | null>
  // Opens a title folder in the OS file manager
  openFolder(path: string): Promise<void>
  // Opens <data folder>/logs (app.log and the per-job ffmpeg output)
  openLogsFolder(): Promise<void>
  // "Save as" dialog; resolves to the chosen path, or null when cancelled
  saveTextFile(suggestedName: string, content: string): Promise<string | null>
  // Absolute path of a File dropped onto the window
  pathForFile(file: File): string
}
