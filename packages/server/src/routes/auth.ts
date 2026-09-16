import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { players } from '../db/schema.js'
import { login, logout } from '../domain/auth.js'
import { issueChallenge } from '../domain/challenges.js'
import { bearerToken } from '../lib/tokens.js'
import { currentPlayer, firstIssue, ipHash, type RouteDeps } from './context.js'

const challengeBody = z.looseObject({}).nullish()

const verifyBody = z.object({
  message: z.string().min(1).max(200),
  publicKey: z.string().min(1).max(200),
  signature: z.string().min(1).max(300),
})

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const limited = { config: { rateLimit: deps.limits.auth } }

  app.post('/api/auth/challenge', limited, async (request, reply) => {
    const body = challengeBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: firstIssue(body.error) })

    const challenge = await issueChallenge(deps.db, 'login', null)
    return reply.send({
      message: challenge.message,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    })
  })

  app.post('/api/auth/verify', limited, async (request, reply) => {
    const body = verifyBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: firstIssue(body.error) })

    const result = await login(deps.db, { ...body.data, ipHash: ipHash(request) })

    if (!result.ok) {
      request.log.warn({ ip: request.ip, reason: result.error }, 'login refused')
      return reply.code(result.status).send({ error: result.error })
    }

    request.log.info({ address: result.address }, 'wallet signed in')
    return reply.send({ token: result.token, address: result.address })
  })

  app.post('/api/auth/logout', { preHandler: deps.requireSession }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization)
    if (token) await logout(deps.db, token)
    return reply.send({ ok: true })
  })

  app.get('/api/me', { preHandler: deps.requireSession }, async (request, reply) => {
    const { address } = currentPlayer(request)

    const [player] = await deps.db.select().from(players).where(eq(players.address, address)).limit(1)
    if (!player) return reply.code(401).send({ error: 'not signed in' })

    return reply.send({
      address: player.address,
      gear: player.gear,
      landlordSince: player.landlordSince,
      createdAt: player.createdAt,
    })
  })
}
