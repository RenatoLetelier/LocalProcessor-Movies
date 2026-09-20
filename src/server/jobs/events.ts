import { EventEmitter } from 'node:events'
import type { AppConfig } from '@shared/config'
import type { Job, LogEntry, Title } from '@shared/model'

// Everything the UI (and any WS client) can observe. Also the WS wire format.
export type ServerEvent =
  | { type: 'job.progress'; job: Job }
  | { type: 'job.updated'; job: Job }
  | { type: 'title.updated'; title: Title }
  | { type: 'title.deleted'; titleId: string }
  | { type: 'job.log'; jobId: string; line: string }
  | { type: 'config.updated'; config: AppConfig }
  | { type: 'log.entry'; entry: LogEntry }

export type EventListener = (event: ServerEvent) => void

export class ServerEvents {
  private readonly emitter = new EventEmitter()

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event)
  }

  subscribe(listener: EventListener): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
