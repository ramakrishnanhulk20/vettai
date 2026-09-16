// Covers the world's sweep of shop orders the treasury has already settled: who is told,
// what it does to the player standing in the world, and what a second pass does. It does
// NOT watch the chain for the payment (watcher.test.ts does), it does NOT cover the gear
// rules themselves (shop.test.ts does), and it does NOT open a real socket (ws.test.ts).

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { shopOrders, STARTING_GEAR } from '../src/db/schema.js'
import { createOrder, markPaid } from '../src/domain/shop.js'
import { worldMap } from '../src/routes/world.js'
import { announcePaidGear } from '../src/world/gear.js'
import { createRooms, PROTOCOL_VERSION, type Rooms, type RoomSocket } from '../src/world/rooms.js'
import { clearTables, freshDb, insertPlayer, randomHash } from './support/db.js'

const map = worldMap()

type Frame = Record<string, unknown> & { t: string }

type Recorder = RoomSocket & { frames: Frame[] }

function fakeSocket(): Recorder {
  const frames: Frame[] = []
  return {
    frames,
    send: (data: string) => {
      frames.push(JSON.parse(data) as Frame)
    },
    close: () => {},
  }
}

let handle: DbHandle
let db: Db
let rooms: Rooms
let address: string

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  rooms = createRooms({ map, seed: 'gear-sweep-test' })
  address = (await insertPlayer(db)).address
})

/** A blaster paid for on chain, the way the treasury's watcher leaves it. */
async function paidOrder(): Promise<string> {
  const order = await createOrder(db, { address, item: 'blaster-mk2' })
  const paid = await markPaid(db, {
    memo: order.memo,
    txHash: randomHash(),
    sender: address,
    valueLuna: order.priceLuna,
    blockNumber: 7,
  })

  if (!paid.ok) throw new Error(`the payment was refused: ${paid.reason}`)
  return order.id
}

function fire(): void {
  rooms.handle(address, JSON.stringify({ v: PROTOCOL_VERSION, t: 'fire', yaw: 0, pitch: 0 }))
}

async function announcedAt(orderId: string): Promise<Date | null> {
  const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, orderId))
  return row?.announcedAt ?? null
}

describe('handing out gear that has been paid for', () => {
  it('tells a player who is in the world and arms the body they are playing', async () => {
    const socket = fakeSocket()
    rooms.join(address, STARTING_GEAR, socket)
    const orderId = await paidOrder()

    const announced = await announcePaidGear(db, rooms)

    expect(announced).toBe(1)
    expect(socket.frames.filter((frame) => frame['kind'] === 'gear')).toEqual([
      {
        v: PROTOCOL_VERSION,
        t: 'event',
        kind: 'gear',
        item: 'blaster-mk2',
        gear: { ...STARTING_GEAR, blaster: 'mk2' },
      },
    ])

    const player = rooms.roomFor(address)?.state.players.get(address)
    expect(player?.gear.blaster).toBe('mk2')

    // The mk2 is the faster blaster: the simulation takes six shots in a second where the
    // starting mk1 stops at four, and it is the room's copy of the gear that decides.
    for (let shot = 0; shot < 6; shot += 1) fire()
    expect(rooms.roomFor(address)?.state.players.get(address)?.recentFires).toHaveLength(6)

    expect(await announcedAt(orderId)).not.toBeNull()
  })

  it('leaves an order alone while its player is away, so the gear waits for the next join', async () => {
    const orderId = await paidOrder()

    const announced = await announcePaidGear(db, rooms)

    expect(announced).toBe(0)
    expect(await announcedAt(orderId)).toBeNull()

    // They come back: the sweep reaches them, and the join would have dressed them anyway.
    const socket = fakeSocket()
    rooms.join(address, STARTING_GEAR, socket)

    expect(await announcePaidGear(db, rooms)).toBe(1)
    expect(await announcedAt(orderId)).not.toBeNull()
  })

  it('announces a purchase once, however often the sweep runs', async () => {
    const socket = fakeSocket()
    rooms.join(address, STARTING_GEAR, socket)
    await paidOrder()

    await announcePaidGear(db, rooms)
    const secondPass = await announcePaidGear(db, rooms)
    const thirdPass = await announcePaidGear(db, rooms)

    expect(secondPass).toBe(0)
    expect(thirdPass).toBe(0)
    expect(socket.frames.filter((frame) => frame['kind'] === 'gear')).toHaveLength(1)
  })
})
