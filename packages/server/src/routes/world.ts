import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { generateMap } from '../world/map.js'
import type { Rooms } from '../world/rooms.js'
import { issueTicket, TICKET_TTL_MS } from '../world/tickets.js'
import type { WorldMap } from '../world/types.js'
import { currentPlayer, type RouteDeps } from './context.js'

/** The map and, when this process is running the world, the rooms on top of it. */
export type WorldDeps = { map: WorldMap; rooms: Rooms | null }

let cached: { map: WorldMap; json: string } | null = null

/**
 * The one city this server runs, generated once from MAP_SEED. Everything that needs the
 * map asks for it here, so the client, the quest engine and the rooms can never end up
 * looking at two different towns.
 */
export function worldMap(): WorldMap {
  if (!cached) {
    const map = generateMap(config.MAP_SEED)
    cached = { map, json: JSON.stringify(map) }
  }
  return cached.map
}

function mapJson(map: WorldMap): string {
  if (!cached || cached.map !== map) cached = { map, json: JSON.stringify(map) }
  return cached.json
}

export function registerWorldRoutes(app: FastifyInstance, deps: RouteDeps, world: WorldDeps): void {
  // The map only changes when the seed or the generator does, and both of those mean a
  // new deploy, so an hour in a phone's cache costs nothing and saves the handshake.
  app.get('/api/world/map', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=3600').type('application/json').send(mapJson(world.map)),
  )

  app.get('/api/world/ticket', { preHandler: deps.requireSession }, async (request, reply) => {
    const { address } = currentPlayer(request)
    const ticket = issueTicket(address)

    request.log.info({ address }, 'handed out a socket ticket')
    return reply.send({ ticket, expiresInMs: TICKET_TTL_MS })
  })
}
