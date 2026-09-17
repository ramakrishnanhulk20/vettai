import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { players } from '../db/schema.js'
import { hasQuestsForDay, questView, todaysQuests } from '../domain/quests.js'
import { bumpDaily } from '../domain/stats.js'
import { utcDay } from '../lib/day.js'
import { PROTOCOL_VERSION, type Rooms } from '../world/rooms.js'
import { redeemTicket } from '../world/tickets.js'
import type { WorldMap } from '../world/types.js'
import type { RouteDeps } from './context.js'

const ticketQuery = z.object({ ticket: z.string().min(1).max(200) })

export type SocketDeps = { map: WorldMap; rooms: Rooms }

/**
 * The play socket.
 *
 * The ticket is spent in the hook, before the upgrade, so a caller without one never gets
 * a socket at all rather than getting one that is then closed. The wallet comes from the
 * ticket and is fixed for the life of the connection: nothing a client sends afterwards
 * can change whose player it is driving.
 */
export function registerWorldSocket(
  app: FastifyInstance,
  deps: RouteDeps,
  world: SocketDeps,
): void {
  app.get(
    '/ws',
    {
      websocket: true,
      preHandler: async (request, reply) => {
        const query = ticketQuery.safeParse(request.query)
        const address = query.success ? redeemTicket(query.data.ticket) : null

        if (!address) {
          request.log.warn({ ip: request.ip }, 'socket refused: the ticket was not good')
          await reply.code(401).send({ error: 'that ticket is not good' })
          return
        }

        request.player = { address }
      },
    },
    (socket, request) => {
      const signedIn = request.player
      if (!signedIn) {
        socket.close(1008, 'no ticket')
        return
      }

      const { address } = signedIn
      let gone = false
      let connectionId: number | null = null

      socket.on('message', (data) => {
        world.rooms.handle(address, data.toString())
      })

      // The rooms ping every member on the tick and cut off the ones that stop answering,
      // which is the only way to tell a phone in a tunnel from a socket that is already gone.
      socket.on('pong', () => {
        world.rooms.pong(address)
      })

      socket.on('close', () => {
        gone = true
        // Before the join there is nothing to leave, and after a reconnect the id is what
        // keeps this close from taking the socket that replaced this one out of the world.
        if (connectionId !== null) world.rooms.leave(address, connectionId)
      })

      socket.on('error', (error: Error) => {
        request.log.warn({ address, err: error }, 'socket failed')
      })

      void (async () => {
        try {
          const [player] = await deps.db
            .select()
            .from(players)
            .where(eq(players.address, address))
            .limit(1)

          if (!player) {
            socket.close(1008, 'unknown player')
            return
          }

          const now = new Date()
          const day = utcDay(now)
          const firstVisitToday = !(await hasQuestsForDay(deps.db, address, day))
          const quests = await todaysQuests(deps.db, address, world.map, now)
          if (firstVisitToday) await bumpDaily(deps.db, day, { players: 1 })

          if (gone || socket.readyState !== socket.OPEN) return

          // Nothing may be awaited between the join and the welcome, or a tick would
          // describe a world to a client that has not been told what it is looking at.
          // The quests go in with the join, so the room can judge an interact that arrives
          // in the same breath as the welcome.
          const views = quests.map(questView)
          const joined = world.rooms.join(address, player.gear, socket, views)
          connectionId = joined.connectionId
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              t: 'welcome',
              // The handle is what this player is called on the wire. The address is here
              // because it is the caller's own, and it goes nowhere else in the room.
              you: { handle: joined.handle, address },
              youSeq: joined.youSeq,
              room: joined.room,
              tick: joined.tick,
              mapVersion: world.map.version,
              players: joined.players,
              drones: joined.drones,
              quests: views,
            }),
          )
        } catch (error) {
          request.log.error({ address, err: error }, 'could not open the world for a player')
          socket.close(1011, 'could not open the world')
        }
      })()
    },
  )
}
