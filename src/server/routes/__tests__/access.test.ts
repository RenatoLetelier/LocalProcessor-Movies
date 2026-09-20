import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InjectOptions } from 'fastify'
import { createTestServer, type TestServer } from './helpers'

let server: TestServer
const LAN_IP = '192.168.1.20'

const get = (url: string, extra: Partial<InjectOptions> = {}) => server.app.inject({ method: 'GET', url, remoteAddress: LAN_IP, ...extra })
const enableLan = async (): Promise<string> => {
  const res = await server.app.inject({ method: 'PUT', url: '/config', payload: { apiAccess: 'lan' } })
  expect(res.statusCode).toBe(200)
  return res.json().apiToken
}

beforeEach(async () => {
  server = await createTestServer()
})

afterEach(() => server.app.close())

describe('access from the network', () => {
  it('is refused with 403 while the API is local-only, whatever the caller sends', async () => {
    expect((await get('/health')).statusCode).toBe(403)
    expect((await get('/titles', { headers: { authorization: 'Bearer anything' } })).json()).toMatchObject({
      statusCode: 403,
      error: 'Forbidden',
      message: expect.stringMatching(/desde este equipo/)
    })
    // Loopback keeps working as before
    expect((await server.app.inject({ method: 'GET', url: '/health', remoteAddress: '127.0.0.1' })).statusCode).toBe(200)
  })

  it('needs the minted token once LAN access is enabled', async () => {
    const token = await enableLan()
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)

    expect((await get('/titles')).json()).toMatchObject({ statusCode: 401, error: 'Unauthorized' })
    expect((await get('/titles', { headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401)
    expect((await get('/titles', { headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200)
    expect((await get('/titles', { headers: { 'x-api-key': token } })).statusCode).toBe(200)
    // The query form is reserved for the WebSocket
    expect((await get(`/titles?token=${token}`)).statusCode).toBe(401)
    // Loopback still needs nothing
    expect((await server.app.inject({ method: 'GET', url: '/titles', remoteAddress: '127.0.0.1' })).statusCode).toBe(200)
  })

  it('checks ?token= on the WebSocket upgrade before handing over to the socket handler', async () => {
    const token = await enableLan()
    const upgrade = { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }
    expect((await get('/jobs/stream?token=wrong', upgrade)).statusCode).toBe(401)
    expect((await get(`/jobs/stream?token=${token}`, upgrade)).statusCode).not.toBe(401)
  })

  it('lets a CORS preflight through without a token', async () => {
    await enableLan()
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: '/titles',
      remoteAddress: LAN_IP,
      headers: { origin: server.allowedOrigins[0]!, 'access-control-request-method': 'POST' }
    })
    expect(res.statusCode).toBe(204)
  })
})

describe('token lifecycle', () => {
  it('keeps the token when LAN access is turned off and reuses it when turned on again', async () => {
    const token = await enableLan()
    const off = await server.app.inject({ method: 'PUT', url: '/config', payload: { apiAccess: 'local' } })
    expect(off.json()).toMatchObject({ apiAccess: 'local', apiToken: token })
    expect((await get('/titles', { headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403)
    expect(await enableLan()).toBe(token)
  })

  it('regenerates on POST /config/api-token and revokes the previous one', async () => {
    const token = await enableLan()
    const events: string[] = []
    server.events.subscribe((e) => e.type !== 'log.entry' && events.push(e.type))

    const res = await server.app.inject({ method: 'POST', url: '/config/api-token' })
    expect(res.statusCode).toBe(200)
    const fresh = res.json().apiToken
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(fresh).not.toBe(token)
    expect(events).toEqual(['config.updated'])

    expect((await get('/titles', { headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401)
    expect((await get('/titles', { headers: { authorization: `Bearer ${fresh}` } })).statusCode).toBe(200)
  })

  it('does not accept a client-chosen token through PUT /config', async () => {
    const res = await server.app.inject({ method: 'PUT', url: '/config', payload: { apiAccess: 'lan', apiToken: 'mine' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/additional properties/)
    expect((await server.app.inject({ method: 'PUT', url: '/config', payload: { apiAccess: 'wifi' } })).statusCode).toBe(400)
  })
})

describe('GET /system', () => {
  it('reports the bound address and the LAN addresses of this machine', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/system' })
    const body = res.json()
    // inject() never binds a socket, so there is no address yet
    expect(body.listening).toBeNull()
    expect(Array.isArray(body.lanAddresses)).toBe(true)
    for (const ip of body.lanAddresses) expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)

    await server.app.listen({ host: '127.0.0.1', port: 0 })
    const bound = (await server.app.inject({ method: 'GET', url: '/system' })).json()
    expect(bound.listening).toMatchObject({ host: '127.0.0.1', port: expect.any(Number) })
  })
})
