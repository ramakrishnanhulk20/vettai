import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { z } from 'zod'
import { config } from '../config.js'
import type { Db } from '../db/client.js'
import { resolveSession } from '../domain/auth.js'
import { bearerToken } from '../lib/tokens.js'

declare module 'fastify' {
  interface FastifyRequest {
    player: { address: string } | null
  }
}

export type RateLimit = { max: number; timeWindow: string }

/** Everything a route group needs, handed in so a test can drive it with its own database. */
export type RouteDeps = {
  db: Db
  requireSession: preHandlerAsyncHookHandler
  limits: { auth: RateLimit }
}

/**
 * The IP the caller came from, hashed so no raw address is ever written down. The salt
 * makes the hash useless to anyone who gets the table and wants to test a guess: the
 * space of IPv4 addresses is small enough to walk through in seconds without one.
 *
 * A plain string is accepted as well as a request, so the prove-it run counts wallets
 * behind an address with the same hash the server writes rather than its own copy of it.
 */
export function ipHash(source: FastifyRequest | string): string {
  const ip = typeof source === 'string' ? source : source.ip
  const salt = config.IP_SALT ?? 'vettai-dev-salt'
  return createHash('sha256').update(`${salt}:${ip}`, 'utf8').digest('hex')
}

/**
 * The gate on every route that acts for a wallet. A refusal is logged with the caller's
 * IP, which is the only thing an unauthenticated caller cannot choose.
 */
export function requireSession(db: Db): preHandlerAsyncHookHandler {
  return async function checkSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearerToken(request.headers.authorization)

    if (!token) {
      request.log.warn({ ip: request.ip, route: request.url }, 'auth refused: no bearer token')
      await reply.code(401).send({ error: 'not signed in' })
      return
    }

    const player = await resolveSession(db, token)
    if (!player) {
      request.log.warn({ ip: request.ip, route: request.url }, 'auth refused: token not accepted')
      await reply.code(401).send({ error: 'not signed in' })
      return
    }

    request.player = { address: player.address }
  }
}

/** The signed-in player on a route that ran requireSession. */
export function currentPlayer(request: FastifyRequest): { address: string } {
  const player = request.player
  if (!player) throw new Error('route used currentPlayer without requireSession')
  return player
}

/** The one thing wrong with the request, in words a client can show a person. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'bad request'
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}
