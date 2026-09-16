import { randomUUID } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { isUniqueViolation } from '../db/errors.js'
import { players, shopOrders, type Gear, type ShopOrder } from '../db/schema.js'
import { comparableAddress } from '../lib/address.js'
import { nimToLuna } from '../lib/luna.js'

/** A shop payment has half an hour to arrive before the order is closed. */
export const ORDER_TTL_MS = 30 * 60 * 1000

export type ShopItemId = 'blaster-mk2' | 'sprint' | 'skin-neon' | 'skin-carbon' | 'skin-sand'

export type ShopItem = {
  id: ShopItemId
  name: string
  priceLuna: bigint
  /** What the purchase changes on the player row. */
  gear: Partial<Gear>
}

/**
 * The whole shop. Prices are in luna and they are the prices the client is told, so a
 * client that asks to pay less is refused by markPaid rather than by the phone.
 */
export const items: Record<ShopItemId, ShopItem> = {
  'blaster-mk2': {
    id: 'blaster-mk2',
    name: 'Blaster MK2',
    priceLuna: nimToLuna('1'),
    gear: { blaster: 'mk2' },
  },
  sprint: { id: 'sprint', name: 'Sprint boots', priceLuna: nimToLuna('0.8'), gear: { sprint: true } },
  'skin-neon': { id: 'skin-neon', name: 'Neon skin', priceLuna: nimToLuna('0.5'), gear: { skin: 'neon' } },
  'skin-carbon': {
    id: 'skin-carbon',
    name: 'Carbon skin',
    priceLuna: nimToLuna('0.5'),
    gear: { skin: 'carbon' },
  },
  'skin-sand': { id: 'skin-sand', name: 'Sand skin', priceLuna: nimToLuna('0.5'), gear: { skin: 'sand' } },
}

export function isShopItem(value: unknown): value is ShopItemId {
  return typeof value === 'string' && Object.hasOwn(items, value)
}

/** The memo the payment carries, which is the only thing tying a transaction to an order. */
export function orderMemo(orderId: string): string {
  return `vettai:shop:${orderId.slice(0, 8)}`
}

export type CreatedOrder = {
  id: string
  item: ShopItemId
  priceLuna: bigint
  memo: string
  expiresAt: Date
}

export type OrderState = 'pending' | 'paid' | 'expired'

export type OrderView = {
  order: ShopOrder
  item: ShopItem
  state: OrderState
  expiresAt: Date
}

export function expiresAt(order: ShopOrder): Date {
  return new Date(order.createdAt.getTime() + ORDER_TTL_MS)
}

/** What the state really is right now: a pending order past its half hour is gone. */
export function effectiveState(order: ShopOrder, now: Date = new Date()): OrderState {
  const stored = order.state as OrderState
  if (stored !== 'pending') return stored
  return expiresAt(order).getTime() <= now.getTime() ? 'expired' : 'pending'
}

export type CreateOrderInput = { address: string; item: ShopItemId; now?: Date }

/**
 * Opens an order and hands back what the phone needs to pay it: the amount and the memo.
 *
 * The id is minted here rather than by the database because the memo is cut from it and
 * the memo has to be unique. A memo that collided with a live order would hand the gear
 * to whoever paid second, so a collision is retried with a new id instead.
 */
export async function createOrder(db: Db, input: CreateOrderInput): Promise<CreatedOrder> {
  const item = items[input.item]
  if (!item) throw new Error(`${String(input.item)} is not in the shop`)

  const now = input.now ?? new Date()

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = randomUUID()
    const memo = orderMemo(id)

    try {
      const [row] = await db
        .insert(shopOrders)
        .values({
          id,
          address: input.address,
          item: item.id,
          priceLuna: item.priceLuna,
          memo,
          createdAt: now,
        })
        .returning()

      if (!row) throw new Error('the order was not written')

      return { id: row.id, item: item.id, priceLuna: item.priceLuna, memo, expiresAt: expiresAt(row) }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }

  throw new Error('could not find a free memo for this order')
}

export async function getOrder(db: Db, id: string, now: Date = new Date()): Promise<OrderView | null> {
  const [order] = await db.select().from(shopOrders).where(eq(shopOrders.id, id)).limit(1)
  if (!order) return null

  const item = items[order.item as ShopItemId]
  if (!item) return null

  return { order, item, state: effectiveState(order, now), expiresAt: expiresAt(order) }
}

/** Closes every order nobody paid in time, so the state a player sees is the real one. */
export async function expireOrders(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(shopOrders)
    .set({ state: 'expired' })
    .where(and(eq(shopOrders.state, 'pending'), lt(shopOrders.createdAt, new Date(now.getTime() - ORDER_TTL_MS))))
    .returning({ id: shopOrders.id })

  return rows.length
}

export type MarkPaidRefusal =
  | 'unknown memo'
  | 'already paid'
  | 'expired'
  | 'sender mismatch'
  | 'short payment'

export type MarkPaidResult =
  | { ok: true; orderId: string; address: string; item: ShopItemId; gear: Gear }
  | { ok: false; reason: MarkPaidRefusal; orderId?: string }

export type MarkPaidInput = {
  memo: string
  txHash: string
  sender: string
  valueLuna: bigint
  blockNumber: number
  /** When the payment was mined. Null or missing when the node did not say. */
  blockTime?: Date | null
  now?: Date
}

/**
 * Turns a payment seen on chain into gear on the player row.
 *
 * Every refusal is a thing a hostile or confused client can actually do: pay from a
 * different wallet than the one that opened the order, pay less than the price, pay an
 * order that has already been paid or that ran out of time. The payment is not returned
 * in any of those cases, so each refusal is written to the log with its reason for Ram
 * to settle by hand. The update is conditional on the order still being pending, which
 * is what makes the same transaction, replayed by the watcher, a no-op.
 *
 * Whether the order ran out of time is judged against the block the payment was mined in
 * and not against the clock. A payment that reached the chain inside the half hour has
 * been paid, however long the treasury then took to read it: a node that was slow, or a
 * process that was restarting, must not turn a player's money into an expired order.
 */
export async function markPaid(db: Db, input: MarkPaidInput): Promise<MarkPaidResult> {
  const now = input.now ?? new Date()
  const paidWhen = input.blockTime ?? now

  const [order] = await db.select().from(shopOrders).where(eq(shopOrders.memo, input.memo)).limit(1)
  if (!order) return { ok: false, reason: 'unknown memo' }

  const item = items[order.item as ShopItemId]
  if (!item) return { ok: false, reason: 'unknown memo', orderId: order.id }

  const state = effectiveState(order, paidWhen)
  if (state === 'paid') return { ok: false, reason: 'already paid', orderId: order.id }
  if (state === 'expired') return { ok: false, reason: 'expired', orderId: order.id }

  if (comparableAddress(input.sender) !== comparableAddress(order.address)) {
    return { ok: false, reason: 'sender mismatch', orderId: order.id }
  }

  if (input.valueLuna < order.priceLuna) return { ok: false, reason: 'short payment', orderId: order.id }

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(shopOrders)
      .set({ state: 'paid', txHash: input.txHash, blockNumber: input.blockNumber, paidAt: now })
      .where(and(eq(shopOrders.id, order.id), eq(shopOrders.state, 'pending')))
      .returning({ id: shopOrders.id })

    if (!claimed) return { ok: false, reason: 'already paid', orderId: order.id }

    const [player] = await tx
      .update(players)
      .set({ gear: sql`${players.gear} || ${JSON.stringify(item.gear)}::jsonb` })
      .where(eq(players.address, order.address))
      .returning({ gear: players.gear })

    if (!player) throw new Error(`order ${order.id} belongs to a player who is not there`)

    return { ok: true, orderId: order.id, address: order.address, item: item.id, gear: player.gear }
  })
}
