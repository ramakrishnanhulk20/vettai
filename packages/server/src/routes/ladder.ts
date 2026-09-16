import type { FastifyInstance } from 'fastify'
import { topByKills, weekOf } from '../domain/ladder.js'
import { rewards } from '../domain/rewards.js'
import { lunaToNim } from '../lib/luna.js'
import type { RouteDeps } from './context.js'

const TOP = 10

/** Enough of an address to recognise your own row, not enough to copy somebody else's. */
export function shortAddress(address: string): string {
  const stripped = address.replace(/\s+/g, '').toUpperCase()
  return `${stripped.slice(0, 8)}...${stripped.slice(-4)}`
}

export function registerLadderRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/ladder/week', async (_request, reply) => {
    const week = weekOf(new Date())
    const entries = await topByKills(deps.db, week, TOP)

    return reply.send({
      week,
      prizesNim: rewards.ladder.map((prize) => lunaToNim(prize)),
      entries: entries.map((entry, place) => ({
        place: place + 1,
        address: shortAddress(entry.address),
        kills: entry.kills,
      })),
    })
  })
}
