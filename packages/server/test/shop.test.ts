// Covers opening a shop order and recognising the payment for it. It does NOT cover the
// shop routes or the phone's send dialog, and it does NOT read the chain: the watcher
// that finds these payments is proven in watcher.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import { players, shopOrders } from '../src/db/schema.js'
import { createOrder, expireOrders, getOrder, items, markPaid, ORDER_TTL_MS } from '../src/domain/shop.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer, randomAddress, randomHash } from './support/db.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const LATER = new Date(NOW.getTime() + ORDER_TTL_MS + 1000)

let handle: DbHandle
let db: Db
let player: string

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  player = (await insertPlayer(db)).address
})

async function gearOf(address: string) {
  const [row] = await db.select().from(players).where(eq(players.address, address))
  return row?.gear
}

describe('the shop', () => {
  it('prices the five items in luna and opens an order with a memo of its own', async () => {
    expect(items['blaster-mk2'].priceLuna).toBe(nimToLuna('1'))
    expect(items.sprint.priceLuna).toBe(nimToLuna('0.8'))
    expect(items['skin-neon'].priceLuna).toBe(nimToLuna('0.5'))
    expect(Object.keys(items)).toHaveLength(5)

    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })

    expect(order.memo).toBe(`vettai:shop:${order.id.slice(0, 8)}`)
    expect(order.priceLuna).toBe(nimToLuna('1'))
    expect(order.expiresAt.getTime()).toBe(NOW.getTime() + ORDER_TTL_MS)

    const view = await getOrder(db, order.id, NOW)
    expect(view?.state).toBe('pending')
  })

  it('lets an order run out after half an hour', async () => {
    const order = await createOrder(db, { address: player, item: 'sprint', now: NOW })

    expect((await getOrder(db, order.id, LATER))?.state).toBe('expired')
    expect(await expireOrders(db, LATER)).toBe(1)

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.id))
    expect(row?.state).toBe('expired')
  })

  it('refuses a payment from a wallet that did not open the order', async () => {
    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })

    const result = await markPaid(db, {
      memo: order.memo,
      txHash: randomHash(),
      sender: randomAddress(),
      valueLuna: order.priceLuna,
      blockNumber: 11_500_001,
      now: NOW,
    })

    expect(result).toMatchObject({ ok: false, reason: 'sender mismatch' })
    expect(await gearOf(player)).toEqual({ blaster: 'mk1', skin: 'default', sprint: false })
  })

  it('refuses a payment that is short and an order nobody paid in time', async () => {
    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })

    const short = await markPaid(db, {
      memo: order.memo,
      txHash: randomHash(),
      sender: player,
      valueLuna: order.priceLuna - 1n,
      blockNumber: 11_500_001,
      now: NOW,
    })
    expect(short).toMatchObject({ ok: false, reason: 'short payment' })

    const late = await markPaid(db, {
      memo: order.memo,
      txHash: randomHash(),
      sender: player,
      valueLuna: order.priceLuna,
      blockNumber: 11_500_001,
      now: LATER,
    })
    expect(late).toMatchObject({ ok: false, reason: 'expired' })

    expect(await markPaid(db, {
      memo: 'vettai:shop:deadbeef',
      txHash: randomHash(),
      sender: player,
      valueLuna: nimToLuna('1'),
      blockNumber: 11_500_001,
      now: NOW,
    })).toMatchObject({ ok: false, reason: 'unknown memo' })
  })

  it('hands over the gear once, however many times the payment is seen', async () => {
    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })
    const txHash = randomHash()

    const paid = await markPaid(db, {
      memo: order.memo,
      txHash,
      sender: player,
      valueLuna: order.priceLuna,
      blockNumber: 11_500_001,
      now: NOW,
    })

    expect(paid).toMatchObject({ ok: true, item: 'blaster-mk2', address: player })
    expect(await gearOf(player)).toMatchObject({ blaster: 'mk2', skin: 'default' })

    const replay = await markPaid(db, {
      memo: order.memo,
      txHash,
      sender: player,
      valueLuna: order.priceLuna,
      blockNumber: 11_500_001,
      now: NOW,
    })
    expect(replay).toMatchObject({ ok: false, reason: 'already paid' })

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.id))
    expect(row?.txHash).toBe(txHash)
    expect(row?.paidAt).not.toBeNull()
  })

  it('pays an order whose payment was mined in time, however late it is read', async () => {
    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })
    const txHash = randomHash()

    const paid = await markPaid(db, {
      memo: order.memo,
      txHash,
      sender: player,
      valueLuna: order.priceLuna,
      blockNumber: 11_500_001,
      blockTime: new Date(NOW.getTime() + 10 * 60 * 1000),
      now: new Date(LATER.getTime() + 60 * 60 * 1000),
    })

    expect(paid).toMatchObject({ ok: true, item: 'blaster-mk2' })

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.id))
    expect(row?.state).toBe('paid')
    expect(row?.blockNumber).toBe(11_500_001)
  })

  it('refuses a payment mined after the half hour even when it is read at once', async () => {
    const order = await createOrder(db, { address: player, item: 'sprint', now: NOW })

    const late = await markPaid(db, {
      memo: order.memo,
      txHash: randomHash(),
      sender: player,
      valueLuna: order.priceLuna,
      blockNumber: 11_500_002,
      blockTime: LATER,
      now: new Date(NOW.getTime() + 60_000),
    })

    expect(late).toMatchObject({ ok: false, reason: 'expired' })
    expect(await gearOf(player)).toMatchObject({ sprint: false })
  })

  it('keeps the gear a player already owns when they buy something else', async () => {
    const blaster = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })
    await markPaid(db, {
      memo: blaster.memo,
      txHash: randomHash(),
      sender: player,
      valueLuna: blaster.priceLuna,
      blockNumber: 11_500_001,
      now: NOW,
    })

    const sprint = await createOrder(db, { address: player, item: 'sprint', now: NOW })
    await markPaid(db, {
      memo: sprint.memo,
      txHash: randomHash(),
      sender: player,
      valueLuna: sprint.priceLuna,
      blockNumber: 11_500_002,
      now: NOW,
    })
    expect(await gearOf(player)).toEqual({ blaster: 'mk2', skin: 'default', sprint: true })

    const skin = await createOrder(db, { address: player, item: 'skin-neon', now: NOW })
    await markPaid(db, {
      memo: skin.memo,
      txHash: randomHash(),
      sender: player,
      valueLuna: nimToLuna('2'),
      blockNumber: 11_500_002,
      now: NOW,
    })

    expect(await gearOf(player)).toEqual({ blaster: 'mk2', skin: 'neon', sprint: true })
  })
})
