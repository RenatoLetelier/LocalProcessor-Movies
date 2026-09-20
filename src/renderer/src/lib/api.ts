import type { AppConfig } from '@shared/config'
import { bridge } from '@/lib/bridge'
import type { CreateTitleResponse, HealthResponse, ImportSummary, LogsQuery, ReprocessRequest, SystemInfo, TitleDetail, TitleFilesResponse } from '@shared/api'
import type { Job, JobStatus, LogEntry, Title } from '@shared/model'

let baseUrlPromise: Promise<string> | undefined

export function apiBaseUrl(): Promise<string> {
  baseUrlPromise ??= bridge.getApiBaseUrl()
  return baseUrlPromise
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${await apiBaseUrl()}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers }
  })
  if (res.status === 204) return undefined as T
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiError(res.status, typeof body.message === 'string' ? body.message : `${res.status} ${res.statusText}`, body)
  }
  return body as T
}

// Plain-text endpoints (log exports, ffmpeg output)
async function requestText(path: string): Promise<string> {
  const res = await fetch(`${await apiBaseUrl()}${path}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new ApiError(res.status, typeof body.message === 'string' ? body.message : `${res.status} ${res.statusText}`, body)
  }
  return res.text()
}

function logsQueryString(query: LogsQuery, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  system: () => request<SystemInfo>('/system'),
  getConfig: () => request<AppConfig>('/config'),
  updateConfig: (patch: Partial<AppConfig>) => request<AppConfig>('/config', { method: 'PUT', body: JSON.stringify(patch) }),
  regenerateApiToken: () => request<AppConfig>('/config/api-token', { method: 'POST' }),
  listTitles: () => request<Title[]>('/titles'),
  getTitle: (id: string) => request<TitleDetail>(`/titles/${id}`),
  getTitleFiles: (id: string) => request<TitleFilesResponse>(`/titles/${id}/files`),
  deleteTitle: (id: string) => request<void>(`/titles/${id}`, { method: 'DELETE' }),
  importTitles: () => request<ImportSummary>('/titles/import', { method: 'POST' }),
  linkTitleSource: (id: string, sourcePath: string) => request<Title>(`/titles/${id}/source`, { method: 'PUT', body: JSON.stringify({ sourcePath }) }),
  reprocessTitle: (id: string, body: ReprocessRequest) =>
    request<CreateTitleResponse>(`/titles/${id}/reprocess`, { method: 'POST', body: JSON.stringify(body) }),
  createTitle: (sourcePath: string, name?: string) =>
    request<CreateTitleResponse>('/titles', { method: 'POST', body: JSON.stringify({ sourcePath, ...(name ? { name } : {}) }) }),
  listJobs: (status: JobStatus[] | 'all' = 'all') =>
    request<Job[]>(`/jobs?status=${status === 'all' ? 'all' : status.join(',')}`),
  cancelJob: (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),
  listLogs: (query: LogsQuery = {}) => request<LogEntry[]>(`/logs${logsQueryString(query)}`),
  logsText: (query: LogsQuery = {}) => requestText(`/logs${logsQueryString(query, { format: 'text' })}`),
  jobOutput: (id: string) => requestText(`/jobs/${id}/log`)
}
