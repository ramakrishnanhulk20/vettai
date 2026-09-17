// Covers one pass of the treasury watcher against a node that lives in this process,
// including the record it keeps of every payment that arrived and what was decided about
// it. It does NOT cover the real RPC paging (listIncoming has its own tests in
// rpc.test.ts), and it does NOT cover the loop, its three second interval, or the
// shutdown.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import { players, receivedPayments, shopOrders, watchCursor } from '../src/db/schema.js'
import { createOrder, ORDER_TTL_MS } from '../src/domain/shop.js'
import { FINALITY_BLOCKS } from '../src/treasury/sender.js'
import { LOOKBACK_BLOCKS, tick } from '../src/treasury/watcher.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer, randomAddress, randomHash } from './support/db.js'
import { FakeRpc } from './support/fakeRpc.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const TREASURY = 'NQ92CT8X1RXLE18507TVJFHA7JF1CG4LBHV7'

let handle: DbHandle
let db: Db
let rpc: FakeRpc
let player: string
let lines: string[]

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  rpc = new FakeRpc()
  lines = []
  player = (await insertPlayer(db)).address
})

/**
 * A block the watcher will act on: old enough that a full batch sits on top of it, and still
 * newer than the cursor the first pass writes a hundred blocks back.
 */
function settled(offset = 0): number {
  return rpc.head - FINALITY_BLOCKS - 5 + offset
}

function options(now: Date = NOW) {
  return { address: TREASURY, now, log: (line: string) => lines.push(line) }
}

async function cursor(): Promise<number | null> {
  const [row] = await db.select().from(watchCursor).where(eq(watchCursor.address, TREASURY))
  return row?.lastBlockNumber ?? null
}

async function paymentRow(hash: string) {
  const [row] = await db.select().from(receivedPayments).where(eq(receivedPayments.txHash, hash))
  return row
}

async function gearOf(address: string) {
  const [row] = await db.select().from(players).where(eq(players.address, address))
  return row?.gear
}

describe('the treasury watcher', () => {
  it('starts a hundred blocks back and moves forward with what it read', async () => {
    const first = await tick(db, rpc, options())

    expect(first.cursor).toBe(rpc.head - LOOKBACK_BLOCKS)
    expect(await cursor()).toBe(rpc.head - LOOKBACK_BLOCKS)

    rpc.receive({
      hash: randomHash(),
      blockNumber: settled(3),
      sender: randomAddress(),
      recipient: TREASURY,
      valueLuna: nimToLuna('1'),
      memo: 'hello there',
    })

    const second = await tick(db, rpc, options())

    expect(second).toMatchObject({ paid: 0, skipped: 1 })
    expect(second.cursor).toBe(settled(3))
    expect(lines.at(-1)).toMatch(/not a shop payment/)
  })

  it('hands over the gear when the payment names a real order', async () => {
    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })
    const hash = randomHash()

    rpc.receive({
      hash,
      blockNumber: settled(1),
      sender: player,
      recipient: TREASURY,
      valueLuna: order.priceLuna,
      memo: order.memo,
    })

    const summary = await tick(db, rpc, options())

    expect(summary.paid).toBe(1)
    expect(await gearOf(player)).toMatchObject({ blaster: 'mk2' })

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.id))
    expect(row?.state).toBe('paid')
    expect(row?.txHash).toBe(hash)
    expect(lines.some((line) => line.includes(order.id))).toBe(true)
  })

  it('skips a payment from a wallet that did not open the order, with the reason', async () => {
    const order = await createOrder(db, { address: player, item: 'sprint', now: NOW })

    rpc.receive({
      hash: randomHash(),
      blockNumber: settled(1),
      sender: randomAddress(),
      recipient: TREASURY,
      valueLuna: order.priceLuna,
      memo: order.memo,
    })

    const summary = await tick(db, rpc, options())

    expect(summary).toMatchObject({ paid: 0, skipped: 1 })
    expect(lines.at(-1)).toMatch(/sender mismatch/)
    expect(await gearOf(player)).not.toMatchObject({ sprint: true })
  })

  it('reads the same payment twice without paying the order twice', async () => {
    const order = await createOrder(db, { address: player, item: 'skin-neon', now: NOW })
    const hash = randomHash()

    rpc.receive({
      hash,
      blockNumber: settled(1),
      sender: player,
      recipient: TREASURY,
      valueLuna: order.priceLuna,
      memo: order.memo,
    })

    expect((await tick(db, rpc, options())).paid).toBe(1)

    await db.update(watchCursor).set({ lastBlockNumber: settled() }).where(eq(watchCursor.address, TREASURY))

    const replay = await tick(db, rpc, options())

    expect(replay).toMatchObject({ paid: 0, skipped: 1 })
    expect(lines.at(-1)).toMatch(/already paid/)

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.id))
    expect(row?.txHash).toBe(hash)
  })

  it('writes down every payment it looked at, and what was decided about it', async () => {
    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })

    const paidHash = randomHash()
    rpc.receive({
      hash: paidHash,
      blockNumber: settled(1),
      blockTime: NOW,
      sender: player,
      recipient: TREASURY,
      valueLuna: order.priceLuna,
      memo: order.memo,
    })

    const strayHash = randomHash()
    rpc.receive({
      hash: strayHash,
      blockNumber: settled(2),
      sender: randomAddress(),
      recipient: TREASURY,
      valueLuna: nimToLuna('2'),
      memo: 'thanks for the game',
    })

    await tick(db, rpc, options())

    const paid = await paymentRow(paidHash)
    expect(paid?.outcome).toBe('paid')
    expect(paid?.orderId).toBe(order.id)
    expect(paid?.valueLuna).toBe(order.priceLuna)
    expect(paid?.blockNumber).toBe(settled(1))
    expect(paid?.blockTime?.toISOString()).toBe(NOW.toISOString())

    const stray = await paymentRow(strayHash)
    expect(stray?.outcome).toBe('unknown_memo')
    expect(stray?.orderId).toBeNull()
    expect(stray?.valueLuna).toBe(nimToLuna('2'))

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.id))
    expect(row?.blockNumber).toBe(settled(1))
  })

  it('keeps the reason a payment was refused, for every kind of refusal', async () => {
    const wrongWallet = await createOrder(db, { address: player, item: 'sprint', now: NOW })
    const shortPay = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })

    const mismatchHash = randomHash()
    rpc.receive({
      hash: mismatchHash,
      blockNumber: settled(1),
      sender: randomAddress(),
      recipient: TREASURY,
      valueLuna: wrongWallet.priceLuna,
      memo: wrongWallet.memo,
    })

    const shortHash = randomHash()
    rpc.receive({
      hash: shortHash,
      blockNumber: settled(2),
      sender: player,
      recipient: TREASURY,
      valueLuna: shortPay.priceLuna - 1n,
      memo: shortPay.memo,
    })

    const summary = await tick(db, rpc, options())

    expect(summary.skipped).toBe(2)
    expect((await paymentRow(mismatchHash))?.outcome).toBe('sender_mismatch')
    expect((await paymentRow(mismatchHash))?.orderId).toBe(wrongWallet.id)
    expect((await paymentRow(shortHash))?.outcome).toBe('short')
    expect((await paymentRow(shortHash))?.valueLuna).toBe(shortPay.priceLuna - 1n)
  })

  it('keeps one record of a payment it reads twice', async () => {
    const order = await createOrder(db, { address: player, item: 'skin-carbon', now: NOW })
    const hash = randomHash()

    rpc.receive({
      hash,
      blockNumber: settled(1),
      sender: player,
      recipient: TREASURY,
      valueLuna: order.priceLuna,
      memo: order.memo,
    })

    await tick(db, rpc, options())
    await db.update(watchCursor).set({ lastBlockNumber: settled() }).where(eq(watchCursor.address, TREASURY))
    await tick(db, rpc, options())

    const rows = await db.select().from(receivedPayments).where(eq(receivedPayments.txHash, hash))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('paid')
  })

  it('closes the orders nobody paid in time on the way past', async () => {
    await createOrder(db, { address: player, item: 'skin-sand', now: NOW })

    const summary = await tick(db, rpc, options(new Date(NOW.getTime() + ORDER_TTL_MS + 1000)))

    expect(summary.expired).toBe(1)

    const [row] = await db.select().from(shopOrders)
    expect(row?.state).toBe('expired')
  })

  it('leaves a payment in the last blocks alone and takes it on a later pass', async () => {
    const order = await createOrder(db, { address: player, item: 'blaster-mk2', now: NOW })
    const hash = randomHash()

    rpc.receive({
      hash,
      blockNumber: rpc.head - 10,
      sender: player,
      recipient: TREASURY,
      valueLuna: order.priceLuna,
      memo: order.memo,
    })

    const early = await tick(db, rpc, options())

    expect(early).toMatchObject({ paid: 0, skipped: 0, young: 1 })
    expect(await paymentRow(hash)).toBeUndefined()
    expect(await gearOf(player)).not.toMatchObject({ blaster: 'mk2' })

    rpc.mine(FINALITY_BLOCKS)
    const later = await tick(db, rpc, options())

    expect(later).toMatchObject({ paid: 1, young: 0 })
    expect(await gearOf(player)).toMatchObject({ blaster: 'mk2' })
  })

  it('pays an order whose payment was mined in time but read long after it ran out', async () => {
    const order = await createOrder(db, { address: player, item: 'sprint', now: NOW })
    const hash = randomHash()

    // The payment reached the chain nine minutes in. The treasury only gets to read it an
    // hour later, by which point the order would have been closed by the clock.
    rpc.receive({
      hash,
      blockNumber: settled(1),
      blockTime: new Date(NOW.getTime() + 9 * 60 * 1000),
      sender: player,
      recipient: TREASURY,
      valueLuna: order.priceLuna,
      memo: order.memo,
    })

    const summary = await tick(db, rpc, options(new Date(NOW.getTime() + ORDER_TTL_MS + 30 * 60 * 1000)))

    expect(summary.paid).toBe(1)
    expect(await gearOf(player)).toMatchObject({ sprint: true })

    const [row] = await db.select().from(shopOrders).where(eq(shopOrders.id, order.id))
    expect(row?.state).toBe('paid')
    expect((await paymentRow(hash))?.outcome).toBe('paid')
  })
})
