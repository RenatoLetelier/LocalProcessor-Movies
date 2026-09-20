import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppConfig } from '@shared/config'
import type { CreateTitleResponse, ImportSummary, ServerEvent } from '@shared/api'
import type { Job, Title } from '@shared/model'
import { api, apiBaseUrl } from '@/lib/api'

export type Connection = 'connecting' | 'online' | 'offline'

export interface AppState {
  connection: Connection
  apiVersion: string | null
  ready: boolean
  loadError: string | null
  config: AppConfig | null
  titles: Title[]
  jobs: Job[]
  reload: () => Promise<void>
  saveConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  regenerateApiToken: () => Promise<AppConfig>
  enqueue: (sourcePath: string, name?: string) => Promise<CreateTitleResponse>
  cancelJob: (id: string) => Promise<void>
  deleteTitle: (id: string) => Promise<void>
  importTitles: () => Promise<ImportSummary>
  linkSource: (id: string, sourcePath: string) => Promise<Title>
  // Raw WebSocket events, for views that want more than the shared lists (the Logs section)
  subscribe: (listener: (event: ServerEvent) => void) => () => void
}

const AppStateContext = createContext<AppState | null>(null)

const RECONNECT_MS = 2000

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id)
  if (index === -1) return [...list, item]
  const copy = list.slice()
  copy[index] = item
  return copy
}

// REST gives the initial picture, the WebSocket keeps it current; on every
// reconnect the lists are reloaded so nothing missed while offline sticks.
export function AppStateProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>('connecting')
  const [apiVersion, setApiVersion] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [titles, setTitles] = useState<Title[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const socketRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef(new Set<(event: ServerEvent) => void>())

  const reload = useCallback(async () => {
    try {
      const [health, cfg, titleList, jobList] = await Promise.all([api.health(), api.getConfig(), api.listTitles(), api.listJobs('all')])
      setApiVersion(health.version)
      setConfig(cfg)
      setTitles(titleList)
      setJobs(jobList)
      setLoadError(null)
      setReady(true)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const handle = (event: ServerEvent): void => {
      switch (event.type) {
        case 'snapshot':
          setJobs((list) => event.jobs.reduce(upsert, list))
          break
        case 'job.progress':
        case 'job.updated':
          setJobs((list) => upsert(list, event.job))
          break
        case 'title.updated':
          setTitles((list) => upsert(list, event.title))
          break
        case 'title.deleted':
          setTitles((list) => list.filter((t) => t.id !== event.titleId))
          setJobs((list) => list.filter((j) => j.title_id !== event.titleId))
          break
        case 'config.updated':
          setConfig(event.config)
          break
      }
      for (const listener of listenersRef.current) listener(event)
    }

    const connect = async (): Promise<void> => {
      if (disposed) return
      const base = await apiBaseUrl()
      const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/jobs/stream`)
      socketRef.current = socket
      socket.onopen = () => {
        setConnection('online')
        void reload()
      }
      socket.onmessage = (message) => handle(JSON.parse(message.data as string) as ServerEvent)
      socket.onclose = () => {
        if (disposed) return
        setConnection('offline')
        timer = setTimeout(() => void connect(), RECONNECT_MS)
      }
      socket.onerror = () => socket.close()
    }

    void connect()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      socketRef.current?.close()
    }
  }, [reload])

  const saveConfig = useCallback(async (patch: Partial<AppConfig>) => {
    const updated = await api.updateConfig(patch)
    setConfig(updated)
    return updated
  }, [])

  const importTitles = useCallback(async () => {
    const summary = await api.importTitles()
    setTitles((list) => [...summary.imported, ...summary.relinked].reduce(upsert, list))
    return summary
  }, [])

  const linkSource = useCallback(async (id: string, sourcePath: string) => {
    const title = await api.linkTitleSource(id, sourcePath)
    setTitles((list) => upsert(list, title))
    return title
  }, [])

  const regenerateApiToken = useCallback(async () => {
    const updated = await api.regenerateApiToken()
    setConfig(updated)
    return updated
  }, [])

  const enqueue = useCallback(async (sourcePath: string, name?: string) => {
    const created = await api.createTitle(sourcePath, name)
    setTitles((list) => upsert(list, created.title))
    setJobs((list) => upsert(list, created.job))
    return created
  }, [])

  const cancelJob = useCallback(async (id: string) => {
    const job = await api.cancelJob(id)
    setJobs((list) => upsert(list, job))
  }, [])

  const deleteTitle = useCallback(async (id: string) => {
    await api.deleteTitle(id)
    setTitles((list) => list.filter((t) => t.id !== id))
    setJobs((list) => list.filter((j) => j.title_id !== id))
  }, [])

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const value = useMemo<AppState>(
    () => ({ connection, apiVersion, ready, loadError, config, titles, jobs, reload, saveConfig, regenerateApiToken, enqueue, cancelJob, deleteTitle, importTitles, linkSource, subscribe }),
    [connection, apiVersion, ready, loadError, config, titles, jobs, reload, saveConfig, regenerateApiToken, enqueue, cancelJob, deleteTitle, importTitles, linkSource, subscribe]
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppState {
  const state = useContext(AppStateContext)
  if (!state) throw new Error('useAppState fuera de AppStateProvider')
  return state
}
