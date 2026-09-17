import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { generateMap, OFFICE_SAFE_RADIUS, PATROL_Y } from '../world/map.js'
import { INTERACT_RANGE, type Rooms } from '../world/rooms.js'
import {
  AIM_CONE_DEGREES,
  BOLT_RADIUS,
  HITSCAN_RANGE,
  MAX_DRONES,
  SPRINT_SPEED,
  WALK_SPEED,
} from '../world/sim.js'
import { issueTicket, TICKET_TTL_MS } from '../world/tickets.js'
import type { WorldMap } from '../world/types.js'
import { currentPlayer, type RouteDeps } from './context.js'

/**
 * The numbers the client has to agree with the server about to draw the same game: how fast
 * a player walks, how far a blaster reaches, where the no-fire circle ends. They are read
 * off the simulation's own constants, so a client can assert against them at boot instead of
 * keeping a second copy that quietly drifts.
 */
export const worldConstants = {
  walkSpeed: WALK_SPEED,
  sprintSpeed: SPRINT_SPEED,
  interactRange: INTERACT_RANGE,
  patrolY: PATROL_Y,
  boltRadius: BOLT_RADIUS,
  hitscanRange: HITSCAN_RANGE,
  aimConeDegrees: AIM_CONE_DEGREES,
  officeSafeRadius: OFFICE_SAFE_RADIUS,
  maxDrones: MAX_DRONES,
} as const

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

  // The same cache window as the map: both only change when a new build goes out.
  app.get('/api/world/constants', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=3600').send(worldConstants),
  )

  app.get('/api/world/ticket', { preHandler: deps.requireSession }, async (request, reply) => {
    const { address } = currentPlayer(request)
    const ticket = issueTicket(address)

    request.log.info({ address }, 'handed out a socket ticket')
    // The socket cannot ride the web app's rewrite (Vercel drops WebSocket upgrades), so the
    // world tells the client where to open it. Blank means same origin, as in local dev.
    return reply.send({ ticket, expiresInMs: TICKET_TTL_MS, wsUrl: config.PUBLIC_WS_URL ?? null })
  })
}
