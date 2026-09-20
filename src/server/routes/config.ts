import type { FastifyPluginAsync } from 'fastify'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AppConfig } from '@shared/config'
import { SEGMENT_DURATION_RANGE, validateConfig } from '@shared/config-validate'
import { generateApiToken } from '../auth'
import type { Repositories } from '../db/repositories'
import type { ServerEvents } from '../jobs/events'
import type { AppLogger } from '../logging/logger'

const rungSchema = {
  type: 'object',
  required: ['width', 'height', 'maxBitrateKbps'],
  additionalProperties: false,
  properties: {
    width: { type: 'integer' },
    height: { type: 'integer' },
    maxBitrateKbps: { type: 'integer' }
  }
} as const

const configPatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputFolder: { type: ['string', 'null'] },
    standards: { type: 'array', items: { type: 'string' } },
    qualities: { type: 'array', items: { type: 'string' } },
    rungs: {
      type: 'object',
      propertyNames: { pattern: '^[a-z0-9]+$' },
      additionalProperties: rungSchema
    },
    segmentDurationSeconds: { type: 'integer', minimum: SEGMENT_DURATION_RANGE.min, maximum: SEGMENT_DURATION_RANGE.max },
    encoder: { type: 'string', enum: ['auto', 'software'] },
    maxConcurrentJobs: { anyOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer', minimum: 1, maximum: 16 }] },
    // apiToken is deliberately absent: the app generates it (POST /config/api-token)
    apiAccess: { type: 'string', enum: ['local', 'lan'] }
  }
} as const

export const configRoutes: FastifyPluginAsync<{ repos: Repositories; events?: ServerEvents; log?: AppLogger }> = async (app, { repos, events, log }) => {
  app.get('/config', async (): Promise<AppConfig> => repos.settings.getConfig())

  app.put<{ Body: Partial<AppConfig> }>('/config', { schema: { body: configPatchSchema } }, async (request, reply) => {
    const patch = request.body
    const merged: AppConfig = { ...repos.settings.getConfig(), ...patch }

    const problems = validateConfig(merged)
    if (typeof patch.outputFolder === 'string') problems.push(...(await checkOutputFolder(patch.outputFolder)))

    if (problems.length > 0) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Configuración inválida: ${problems.join('; ')}`,
        problems
      })
    }

    // The first time LAN access is enabled the token is minted along with it
    const minted = merged.apiAccess === 'lan' && !merged.apiToken
    if (minted) patch.apiToken = generateApiToken()
    const previous = repos.settings.getConfig()
    const updated = repos.settings.updateConfig(patch)
    events?.emit({ type: 'config.updated', config: updated })
    const changes = configChanges(previous, updated)
    if (Object.keys(changes).length > 0) {
      log?.info('config', `Configuración actualizada: ${Object.keys(changes).join(', ')}${minted ? ' (token de acceso generado)' : ''}`, { context: { changes, ip: request.ip } })
    }
    return updated
  })

  // Replaces the token; whoever holds the old one loses access immediately
  app.post('/config/api-token', async (request): Promise<AppConfig> => {
    const updated = repos.settings.updateConfig({ apiToken: generateApiToken() })
    events?.emit({ type: 'config.updated', config: updated })
    log?.info('config', 'Token de acceso desde la red regenerado; el anterior deja de valer', { context: { ip: request.ip } })
    return updated
  })
}

// Field-by-field diff for the log; the token itself never gets written
function configChanges(before: AppConfig, after: AppConfig): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after) as (keyof AppConfig)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
    changes[key] = key === 'apiToken' ? { from: before[key] ? '(token)' : null, to: after[key] ? '(token nuevo)' : null } : { from: before[key], to: after[key] }
  }
  return changes
}

async function checkOutputFolder(folder: string): Promise<string[]> {
  if (!isAbsolute(folder)) return ['outputFolder: debe ser una ruta absoluta']
  try {
    const info = await stat(folder)
    return info.isDirectory() ? [] : ['outputFolder: la ruta no es una carpeta']
  } catch {
    return ['outputFolder: la carpeta no existe']
  }
}
