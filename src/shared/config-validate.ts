import type { AppConfig } from './config'

const STANDARDS = ['hls', 'dash']
export const SEGMENT_DURATION_RANGE = { min: 1, max: 60 }

// Cross-field rules a JSON schema cannot express. Returns human-readable
// problems (Spanish, shown as-is by the UI and the API); empty means valid.
export function validateConfig(config: AppConfig): string[] {
  const problems: string[] = []

  if (config.standards.length === 0) problems.push('standards: debe incluir al menos un estándar (hls, dash)')
  if (new Set(config.standards).size !== config.standards.length) problems.push('standards: contiene valores repetidos')
  for (const standard of config.standards) {
    if (!STANDARDS.includes(standard)) problems.push(`standards: valor desconocido "${standard}"`)
  }

  if (config.qualities.length === 0) problems.push('qualities: debe incluir al menos una calidad')
  if (new Set(config.qualities).size !== config.qualities.length) problems.push('qualities: contiene valores repetidos')
  for (const label of config.qualities) {
    if (!(label in config.rungs)) problems.push(`qualities: "${label}" no está definida en rungs`)
  }

  for (const [label, rung] of Object.entries(config.rungs)) {
    if (!Number.isInteger(rung.width) || rung.width < 16 || rung.width % 2 !== 0) {
      problems.push(`rungs.${label}.width: debe ser un entero par ≥ 16`)
    }
    if (!Number.isInteger(rung.height) || rung.height < 16 || rung.height % 2 !== 0) {
      problems.push(`rungs.${label}.height: debe ser un entero par ≥ 16`)
    }
    if (!Number.isInteger(rung.maxBitrateKbps) || rung.maxBitrateKbps <= 0) {
      problems.push(`rungs.${label}.maxBitrateKbps: debe ser un entero positivo`)
    }
  }

  if (typeof config.copyVideo !== 'boolean') problems.push('copyVideo: debe ser true o false')
  if (!Number.isInteger(config.copyVideoMaxKbps) || config.copyVideoMaxKbps <= 0) {
    problems.push('copyVideoMaxKbps: debe ser un entero positivo')
  }

  if (config.encoder !== 'auto' && config.encoder !== 'software') problems.push('encoder: debe ser "auto" o "software"')
  const jobs = config.maxConcurrentJobs
  if (jobs !== 'auto' && (!Number.isInteger(jobs) || jobs < 1 || jobs > 16)) {
    problems.push('maxConcurrentJobs: debe ser "auto" o un entero entre 1 y 16')
  }

  if (config.apiAccess !== 'local' && config.apiAccess !== 'lan') problems.push('apiAccess: debe ser "local" o "lan"')
  if (config.apiToken !== null && (typeof config.apiToken !== 'string' || config.apiToken.length === 0)) {
    problems.push('apiToken: debe ser null o un texto no vacío')
  }

  const seconds = config.segmentDurationSeconds
  if (!Number.isInteger(seconds) || seconds < SEGMENT_DURATION_RANGE.min || seconds > SEGMENT_DURATION_RANGE.max) {
    problems.push(
      `segmentDurationSeconds: debe ser un entero entre ${SEGMENT_DURATION_RANGE.min} y ${SEGMENT_DURATION_RANGE.max}`
    )
  }

  return problems
}
