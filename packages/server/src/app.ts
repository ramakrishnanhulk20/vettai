import fastifyCors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { allowedOrigins, config, trustedProxies } from './config.js'
import type { Db } from './db/client.js'
import { registerAuthRoutes } from './routes/auth.js'
import { requireSession, type RouteDeps } from './routes/context.js'
import { registerLadderRoutes } from './routes/ladder.js'
import { registerQuestRoutes } from './routes/quests.js'
import { registerShopRoutes } from './routes/shop.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerWorldSocket } from './routes/ws.js'
import { registerWorldRoutes, worldMap, type WorldDeps } from './routes/world.js'

/**
 * Per minute, per IP. Signing in is tighter than the rest because it ends in a
 * signature check, which is the expensive thing an attacker would grind at.
 */
export const RATE_LIMITS = { global: 120, auth: 10 }

/** A frame is a few hundred bytes; anything near this is not a client we want to read. */
const MAX_SOCKET_FRAME = 8 * 1024

export type BuildOptions = {
  db: Db
  rateLimit?: Partial<typeof RATE_LIMITS>
  /** Tests turn the request log off so the run is readable. The server always logs. */
  logger?: boolean
  /**
   * The running world. Without the rooms the API still serves the map and the public
   * reads, which is what an API-only test or a second read replica needs.
   */
  world?: WorldDeps
}

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: 'info' },
    // Only the hops named in TRUST_PROXY may say where a caller came from. Blank, the
    // local default, means the header is ignored and the socket's own address wins.
    trustProxy: trustedProxies(),
  })
  const limits = { ...RATE_LIMITS, ...options.rateLimit }
  const origins = allowedOrigins()
  const world: WorldDeps = options.world ?? { map: worldMap(), rooms: null }

  await app.register(fastifyCors, {
    origin: origins.length > 0 ? origins : false,
    credentials: false,
  })

  await app.register(fastifyRateLimit, {
    global: true,
    max: limits.global,
    timeWindow: '1 minute',
    // Keyed on the address the packet came from, never on anything the caller can set.
    keyGenerator: (request) => request.ip,
    onExceeded: (request) => {
      request.log.warn({ ip: request.ip, route: request.url }, 'rate limit hit')
    },
    // The plugin throws what this returns, so it has to be a real Error carrying the
    // status. The error handler below turns it into the same { error } shape as
    // everything else.
    errorResponseBuilder: (_request, context) => {
      const error = new Error('too many requests, wait a minute')
      return Object.assign(error, { statusCode: context.statusCode })
    },
  })

  if (world.rooms) {
    // iOS WebViews drop compressed sockets, and Vettai lives inside one.
    await app.register(fastifyWebsocket, {
      options: { perMessageDeflate: false, maxPayload: MAX_SOCKET_FRAME },
    })
  }

  // Every failure leaves by the same door, so a client only ever parses { error }. A
  // 500 says nothing about what broke; the detail goes to the log, not to the caller.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status >= 500) request.log.error({ err: error, route: request.url }, 'request failed')
    return reply.code(status).send({ error: status >= 500 ? 'something went wrong' : error.message })
  })

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not found' }))

  app.decorateRequest('player', null)

  const deps: RouteDeps = {
    db: options.db,
    requireSession: requireSession(options.db),
    limits: { auth: { max: limits.auth, timeWindow: '1 minute' } },
  }

  // Point this at a deployment to see which address the world thinks a caller has. A
  // wrong TRUST_PROXY shows up here as the edge's address, or as a header a caller chose.
  app.get('/api/echo-ip', async (request, reply) => reply.send({ ip: request.ip }))

  app.get('/health', () => {
    const live = world.rooms?.snapshot() ?? { rooms: 0, online: 0 }
    return { ok: true, network: config.NIMIQ_NETWORK, rooms: live.rooms, online: live.online }
  })

  registerAuthRoutes(app, deps)
  registerWorldRoutes(app, deps, world)
  registerQuestRoutes(app, deps, world)
  registerShopRoutes(app, deps)
  registerLadderRoutes(app, deps)
  registerStatsRoutes(app, deps)
  if (world.rooms) registerWorldSocket(app, deps, { map: world.map, rooms: world.rooms })

  return app
}
