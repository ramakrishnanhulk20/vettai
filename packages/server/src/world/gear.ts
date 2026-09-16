import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { players, shopOrders } from '../db/schema.js'
import type { Rooms } from './rooms.js'

/** How often the world looks for a payment the treasury has settled since the last look. */
export const GEAR_SWEEP_MS = 5000

/** One pass stays one small query, however many payments landed at once. */
export const GEAR_SWEEP_BATCH = 50

export type SweepOptions = {
  db: Db
  rooms: Rooms
  intervalMs?: number
  log?: (line: string, detail?: Record<string, unknown>) => void
}

/**
 * Hands out the gear behind every payment the treasury has settled and the player has not
 * been told about yet.
 *
 * The treasury writes the payment down; the world is the only process holding sockets, so
 * it is the one that can say so. The order is deliberate: the live player is given the gear,
 * then the socket is told, and only then is the order stamped as announced. A player who is
 * offline is left unstamped and gets the gear from their own row at the next join, so a
 * purchase is never announced into the void.
 */
export async function announcePaidGear(db: Db, rooms: Rooms, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({
      id: shopOrders.id,
      address: shopOrders.address,
      item: shopOrders.item,
      gear: players.gear,
    })
    .from(shopOrders)
    .innerJoin(players, eq(players.address, shopOrders.address))
    .where(and(eq(shopOrders.state, 'paid'), isNull(shopOrders.announcedAt)))
    .orderBy(asc(shopOrders.paidAt))
    .limit(GEAR_SWEEP_BATCH)

  let announced = 0

  for (const order of due) {
    rooms.setGear(order.address, order.gear)

    const reached = rooms.send(order.address, {
      t: 'event',
      kind: 'gear',
      item: order.item,
      gear: order.gear,
    })
    if (!reached) continue

    await db
      .update(shopOrders)
      .set({ announcedAt: now })
      .where(and(eq(shopOrders.id, order.id), isNull(shopOrders.announcedAt)))

    announced += 1
  }

  return announced
}

export type GearSweep = { stop: () => void }

/** Runs the sweep every few seconds for as long as the world is up. */
export function startGearSweep(options: SweepOptions): GearSweep {
  const log = options.log ?? (() => {})
  const every = options.intervalMs ?? GEAR_SWEEP_MS

  const timer = setInterval(() => {
    void announcePaidGear(options.db, options.rooms).then(
      (announced) => {
        if (announced > 0) log('handed out gear that was paid for', { announced })
      },
      (error: unknown) => {
        log('could not hand out the gear that was paid for', { error: String(error) })
      },
    )
  }, every)

  timer.unref?.()

  return {
    stop: (): void => {
      clearInterval(timer)
    },
  }
}
