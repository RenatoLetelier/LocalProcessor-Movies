import * as initial from './001-initial'
import * as jobsAttempts from './002-jobs-attempts'
import * as externalTracks from './003-external-tracks'
import * as audioCompanions from './004-audio-companions'
import * as titleHdr from './005-title-hdr'
import * as nullableSourcePath from './006-nullable-source-path'
import * as logs from './007-logs'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrations: Migration[] = [
  { version: 1, ...initial },
  { version: 2, ...jobsAttempts },
  { version: 3, ...externalTracks },
  { version: 4, ...audioCompanions },
  { version: 5, ...titleHdr },
  { version: 6, ...nullableSourcePath },
  { version: 7, ...logs }
]
