import fastifyCors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify'
import { allowedOrigins, config, trustProxy } from './config.js'
import type { Db } from './db/client.js'
import { resolveSession } from './domain/auth.js'
import { bearerToken, hashToken } from './lib/tokens.js'
import { registerAuthRoutes } from './routes/auth.js'
import { requireSession, type RouteDeps } from './routes/context.js'
import { registerLadderRoutes } from './routes/ladder.js'
import { registerQuestRoutes } from './routes/quests.js'
import { registerShopRoutes } from './routes/shop.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerWorldSocket } from './routes/ws.js'
import { registerWorldRoutes, worldMap, type WorldDeps } from './routes/world.js'

/**
 * Per minute. `global` and `auth` are counted per IP, `session` per signed-in wallet.
 * Signing in is tighter than the rest because it ends in a signature check, which is the
 * expensive thing an attacker would grind at. A session gets more than an anonymous caller
 * because a house with two phones on one router is two players, not one.
 */
export const RATE_LIMITS = { global: 120, auth: 10, session: 240 }

/**
 * What the limiter counts a request against. A made-up bearer token would be a fresh budget
 * on demand, so the session has to be a real one; anything else falls back to the address
 * the packet came from, which is the one thing a caller cannot choose.
 */
async function limiterKey(db: Db, request: FastifyRequest): Promise<string> {
  const token = bearerToken(request.headers.authorization)
  if (!token) return `ip:${request.ip}`

  try {
    const player = await resolveSession(db, token)
    if (player) return `session:${hashToken(token)}`
  } catch (error) {
    request.log.warn({ err: error }, 'could not read a session for the rate limit key')
  }

  return `ip:${request.ip}`
}

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
    // Only the peer named in TRUST_PROXY, and the platform's own hops behind it, may say
    // where a caller came from. Blank, the local default, means the header is ignored and
    // the socket's own address wins.
    trustProxy: trustProxy(),
  })
  const limits = { ...RATE_LIMITS, ...options.rateLimit }
  // A test that lifts the anonymous ceiling means "do not measure me here", so the session
  // ceiling follows it up rather than staying at the production number and failing the test.
  const perSession = options.rateLimit?.session ?? Math.max(limits.session, limits.global)
  const origins = allowedOrigins()
  const world: WorldDeps = options.world ?? { map: worldMap(), rooms: null }

  await app.register(fastifyCors, {
    origin: origins.length > 0 ? origins : false,
    credentials: false,
  })

  await app.register(fastifyRateLimit, {
    global: true,
    // The ceiling is read off the key the request was given, so the two can never disagree
    // about whether this is a session or an address.
    max: (_request, key) => (String(key).startsWith('session:') ? perSession : limits.global),
    timeWindow: '1 minute',
    keyGenerator: (request) => limiterKey(options.db, request),
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

  // Point this at a deployment to see which address the world thinks a caller has, and why.
  // A wrong TRUST_PROXY or TRUST_PROXY_EDGE_HOPS shows up here as the edge's own address:
  // compare `ip` against the chain and the peer and the setting is right or it is not.
  app.get('/api/echo-ip', async (request, reply) =>
    reply.send({
      ip: request.ip,
      chain: request.headers['x-forwarded-for'] ?? null,
      peer: request.socket.remoteAddress ?? null,
    }),
  )

  app.get('/health', () => {
    const live = world.rooms?.snapshot() ?? { rooms: 0, online: 0 }
    return {
      ok: true,
      network: config.NIMIQ_NETWORK,
      rooms: live.rooms,
      online: live.online,
      dailyCapNim: config.DAILY_CAP_NIM,
    }
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
