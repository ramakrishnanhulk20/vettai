// Covers the shop over HTTP: what is for sale, opening an order, and what the owner of an
// order is told once the payment lands. It does NOT watch the chain for that payment
// (watcher.test.ts does), it does NOT cover the gear rules themselves, which are proven in
// shop.test.ts, and it does NOT hand the gear over: gear.sweep.test.ts covers that.

import { KeyPair } from '@nimiq/core'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import type { Db, DbHandle } from '../src/db/client.js'
import { players, shopOrders, STARTING_GEAR } from '../src/db/schema.js'
import { markPaid } from '../src/domain/shop.js'
import { worldMap } from '../src/routes/world.js'
import { createRooms, type Rooms, type RoomSocket } from '../src/world/rooms.js'
import { signIn, testApp, type SignedIn } from './support/api.js'
import { clearTables, freshDb, randomHash } from './support/db.js'

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
let app: FastifyInstance
let rooms: Rooms
let wallet: KeyPair
let signedIn: SignedIn

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  wallet = KeyPair.generate()
  rooms = createRooms({ map, seed: 'shop-test' })
  app = await testApp(db, { world: { map, rooms } })
  signedIn = await signIn(app, wallet)
})

afterEach(async () => {
  rooms.stop()
  await app.close()
})

function openOrder(item: string) {
  return app.inject({
    method: 'POST',
    url: '/api/shop/orders',
    headers: signedIn.auth,
    payload: { item },
  })
}

describe('GET /api/shop', () => {
  it('lists every item with its price and where to pay', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/shop' })

    const body = response.json<{ to: string; items: { id: string; priceNim: string }[] }>()
    expect(response.statusCode).toBe(200)
    expect(body.to).toBe(config.TREASURY_ADDRESS)
    expect(body.items.map((item) => item.id)).toContain('sprint')
    expect(body.items.find((item) => item.id === 'blaster-mk2')?.priceNim).toBe('0.6')
  })
})

describe('POST /api/shop/orders', () => {
  it('opens a pending order with the memo the payment has to carry', async () => {
    const response = await openOrder('sprint')

    const body = response.json<{ orderId: string; memo: string; to: string; nim: string }>()
    expect(response.statusCode).toBe(200)
    expect(body.memo).toBe(`vettai:shop:${body.orderId.slice(0, 8)}`)
    expect(body.to).toBe(config.TREASURY_ADDRESS)
    expect(body.nim).toBe('0.8')

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, body.orderId))
    expect(row?.state).toBe('pending')
    expect(row?.address).toBe(signedIn.address)
  })

  it('refuses an item that is not in the shop and a caller with no session', async () => {
    const madeUp = await openOrder('rocket-launcher')
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/shop/orders',
      payload: { item: 'sprint' },
    })

    expect(madeUp.statusCode).toBe(400)
    expect(madeUp.json()).toEqual({ error: 'that is not in the shop' })
    expect(anonymous.statusCode).toBe(401)
  })
})

describe('GET /api/shop/orders/:id', () => {
  it('reports the order to its owner and hides it from everybody else', async () => {
    const { orderId } = (await openOrder('sprint')).json<{ orderId: string }>()
    const stranger = await signIn(app, KeyPair.generate())

    const mine = await app.inject({
      method: 'GET',
      url: `/api/shop/orders/${orderId}`,
      headers: signedIn.auth,
    })
    const theirs = await app.inject({
      method: 'GET',
      url: `/api/shop/orders/${orderId}`,
      headers: stranger.auth,
    })

    expect(mine.json<{ state: string; item: string }>()).toMatchObject({
      state: 'pending',
      item: 'sprint',
    })
    expect(theirs.statusCode).toBe(404)
    expect(theirs.json()).toEqual({ error: 'no such order' })
  })

  it('reports a paid order without handing anything out itself', async () => {
    const socket = fakeSocket()
    rooms.join(signedIn.address, STARTING_GEAR, socket)

    const order = (await openOrder('sprint')).json<{ orderId: string; memo: string }>()
    const paid = await markPaid(db, {
      memo: order.memo,
      txHash: randomHash(),
      sender: signedIn.address,
      valueLuna: 80_000n,
      blockNumber: 42,
    })
    expect(paid.ok).toBe(true)

    const first = await app.inject({
      method: 'GET',
      url: `/api/shop/orders/${order.orderId}`,
      headers: signedIn.auth,
    })
    const second = await app.inject({
      method: 'GET',
      url: `/api/shop/orders/${order.orderId}`,
      headers: signedIn.auth,
    })

    expect(first.json<{ state: string }>().state).toBe('paid')
    expect(second.json<{ state: string }>().state).toBe('paid')

    // Reading the order is not what delivers the gear, so a phone that never asks misses
    // nothing: the sweep announces it, and the order is still waiting for that sweep.
    expect(socket.frames.filter((frame) => frame['kind'] === 'gear')).toHaveLength(0)

    const [row] = await db.select().from(players).where(eq(players.address, signedIn.address))
    expect(row?.gear.sprint).toBe(true)

    const [stored] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.orderId))
    expect(stored?.announcedAt).toBeNull()
  })

  it('refuses an order id that is not an id at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/shop/orders/nonsense',
      headers: signedIn.auth,
    })

    expect(response.statusCode).toBe(400)
  })
})
