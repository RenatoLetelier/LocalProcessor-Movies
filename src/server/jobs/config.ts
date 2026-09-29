import type { AppConfig, Rung, Standard } from '@shared/config'
import type { PlanOptions } from '@pipeline/types'
import { validateConfig } from '@shared/config-validate'
import { badRequest, conflict } from '../errors'

// What a job needs, frozen at enqueue time so later config edits never change a queued job
export interface JobConfig {
  outputFolder: string
  standards: Standard[]
  qualities: string[]
  rungs: Record<string, Rung>
  segmentDurationSeconds: number
  encoder: AppConfig['encoder']
  // Absent in jobs queued before 1.3.0: those encode, as they did
  copyVideo?: boolean
  copyVideoMaxKbps?: number
}

export interface ConfigOverrides {
  standards?: Standard[]
  qualities?: string[]
  segmentDurationSeconds?: number
}

export function snapshotJobConfig(global: AppConfig, overrides: ConfigOverrides = {}): JobConfig {
  if (!global.outputFolder) throw conflict('Configura la carpeta de salida antes de encolar títulos (PUT /config { outputFolder })')

  const merged: AppConfig = { ...global }
  if (overrides.standards !== undefined) merged.standards = overrides.standards
  if (overrides.qualities !== undefined) merged.qualities = overrides.qualities
  if (overrides.segmentDurationSeconds !== undefined) merged.segmentDurationSeconds = overrides.segmentDurationSeconds

  const problems = validateConfig(merged)
  if (problems.length > 0) throw badRequest(`Configuración inválida: ${problems.join('; ')}`, { problems })

  return {
    outputFolder: global.outputFolder,
    standards: merged.standards,
    qualities: merged.qualities,
    rungs: structuredClone(merged.rungs),
    segmentDurationSeconds: merged.segmentDurationSeconds,
    encoder: merged.encoder,
    copyVideo: merged.copyVideo,
    copyVideoMaxKbps: merged.copyVideoMaxKbps
  }
}

export function planOptionsOf(config: JobConfig): PlanOptions {
  return {
    rungs: config.rungs,
    qualities: config.qualities,
    segmentDurationSeconds: config.segmentDurationSeconds,
    ...(config.copyVideo && config.copyVideoMaxKbps ? { copyVideo: { maxBitrateKbps: config.copyVideoMaxKbps } } : {})
  }
}

export function parseJobConfig(json: string): JobConfig {
  return JSON.parse(json) as JobConfig
}
