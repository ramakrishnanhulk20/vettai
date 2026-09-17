// Covers the promise that a cap is a delay and not a forfeiture: when a held claim is
// looked at again, what happens when it passes, and what happens when it is still over.
// It does NOT cover the treasury loop that calls releaseHeld on its minute (that is a
// timer in src/treasury/index.ts), and it does NOT send anything: the outbox picks the
// released claim up as any other queued row, which outbox.test.ts covers.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, quests } from '../src/db/schema.js'
import { queueClaim, releaseHeld, type Limits } from '../src/domain/claims.js'
import { payLadder } from '../src/domain/ladder.js'
import { rewards } from '../src/domain/rewards.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer, randomAddress } from './support/db.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const MIDNIGHT = new Date('2026-09-16T00:00:00Z')
const TOMORROW = new Date('2026-09-16T00:30:00Z')

const CAP: Limits = { dailyCapLuna: nimToLuna('0.5'), poolTotalLuna: nimToLuna('100'), ipWalletsPerDay: 2 }

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

async function claimRow(id: string) {
  const [row] = await db.select().from(claims).where(eq(claims.id, id)).limit(1)
  return row
}

async function claimFor(
  address: string,
  amount: string,
  now: Date,
  limits: Limits = CAP,
  ipHash: string | null = null,
) {
  return queueClaim(db, {
    address,
    questId: null,
    kind: 'ladder',
    amountLuna: nimToLuna(amount),
    memo: `vettai:test:${Math.random().toString(16).slice(2, 10)}`,
    now,
    limits,
    ipHash,
  })
}

describe('a held claim waits rather than disappearing', () => {
  it('dates a cap hold to the next UTC midnight and leaves a pool hold undated', async () => {
    await claimFor(player, '0.5', NOW)
    const capped = await claimFor(player, '0.3', NOW)
    expect(capped.state).toBe('held')
    expect((await claimRow(capped.claimId))?.heldUntil?.toISOString()).toBe(MIDNIGHT.toISOString())

    const other = randomAddress()
    await insertPlayer(db, other)
    const pool = await claimFor(other, '0.4', NOW, { ...CAP, poolTotalLuna: nimToLuna('0.6') })
    expect(pool).toMatchObject({ state: 'held', reason: 'pool' })
    expect((await claimRow(pool.claimId))?.heldUntil).toBeNull()
  })

  it('leaves the claim held until its day is over', async () => {
    await claimFor(player, '0.5', NOW)
    const held = await claimFor(player, '0.3', NOW)

    const summary = await releaseHeld(db, new Date(NOW.getTime() + 60_000), CAP)

    expect(summary).toEqual({ released: 0, stillHeld: 0 })
    expect((await claimRow(held.claimId))?.state).toBe('held')
  })

  it('queues the claim the next day and keeps what it has already tried', async () => {
    await claimFor(player, '0.5', NOW)
    const held = await claimFor(player, '0.3', NOW)
    await db.update(claims).set({ attempts: 2 }).where(eq(claims.id, held.claimId))

    const summary = await releaseHeld(db, TOMORROW, CAP)

    expect(summary).toEqual({ released: 1, stillHeld: 0 })

    const row = await claimRow(held.claimId)
    expect(row?.state).toBe('queued')
    expect(row?.heldUntil).toBeNull()
    expect(row?.error).toBeNull()
    expect(row?.attempts).toBe(2)
    expect(row?.createdAt.toISOString()).toBe(TOMORROW.toISOString())
  })

  it('holds it for another day when the wallet is over the cap again', async () => {
    await claimFor(player, '0.5', NOW)
    const held = await claimFor(player, '0.3', NOW)
    await claimFor(player, '0.5', TOMORROW)

    const summary = await releaseHeld(db, TOMORROW, CAP)

    expect(summary).toEqual({ released: 0, stillHeld: 1 })

    const row = await claimRow(held.claimId)
    expect(row?.state).toBe('held')
    expect(row?.error).toBe('daily cap')
    expect(row?.heldUntil?.toISOString()).toBe('2026-09-17T00:00:00.000Z')
  })

  it('frees a claim the house held once the house has a new day', async () => {
    const limits: Limits = { ...CAP, ipWalletsPerDay: 1 }

    const neighbour = randomAddress()
    await insertPlayer(db, neighbour)
    await claimFor(neighbour, '0.3', NOW, limits, 'one-house')

    const held = await claimFor(player, '0.3', NOW, limits, 'one-house')
    expect(held).toMatchObject({ state: 'held', reason: 'ip cap' })

    expect(await releaseHeld(db, TOMORROW, limits)).toEqual({ released: 1, stillHeld: 0 })
    expect((await claimRow(held.claimId))?.state).toBe('queued')
  })

  it('frees a pool hold on the very next pass once a payout is cancelled', async () => {
    const limits: Limits = { ...CAP, poolTotalLuna: nimToLuna('0.6') }

    const spender = randomAddress()
    await insertPlayer(db, spender)
    const committed = await claimFor(spender, '0.5', NOW, limits)

    const held = await claimFor(player, '0.3', NOW, limits)
    expect(held).toMatchObject({ state: 'held', reason: 'pool' })

    // A failed payout is still owed, so it keeps its room in the pool. Only cancelling it,
    // which is Ram's decision and nobody else's, gives the room back.
    await db.update(claims).set({ state: 'failed' }).where(eq(claims.id, committed.claimId))

    const stillShort = await releaseHeld(db, new Date(NOW.getTime() + 60_000), limits)
    expect(stillShort).toEqual({ released: 0, stillHeld: 1 })
    expect((await claimRow(held.claimId))?.heldUntil).toBeNull()

    await db.update(claims).set({ state: 'cancelled' }).where(eq(claims.id, committed.claimId))

    expect(await releaseHeld(db, new Date(NOW.getTime() + 120_000), limits)).toEqual({
      released: 1,
      stillHeld: 0,
    })
    expect((await claimRow(held.claimId))?.state).toBe('queued')
  })

  it('releases a ladder prize the cap held, on the next day', async () => {
    const week = '2026-W38'
    const monday = new Date('2026-09-21T00:05:00Z')

    await db.insert(quests).values({
      address: player,
      day: '2026-09-15',
      kind: 'hunt',
      target: 5,
      progress: 30,
      state: 'done',
      rewardLuna: nimToLuna('0.5'),
    })

    await queueClaim(db, {
      address: player,
      questId: null,
      kind: 'ladder',
      amountLuna: nimToLuna('4'),
      memo: 'vettai:test:filler',
      now: monday,
    })

    const result = await payLadder(db, week, monday)
    expect(result.claimIds).toHaveLength(1)

    const prizeId = result.claimIds[0] ?? ''
    const prize = await claimRow(prizeId)
    expect(prize?.state).toBe('held')
    expect(prize?.amountLuna).toBe(rewards.ladder[0])
    expect(prize?.error).toBe('daily cap')

    const nextDay = new Date('2026-09-22T00:10:00Z')
    expect(await releaseHeld(db, nextDay)).toEqual({ released: 1, stillHeld: 0 })
    expect((await claimRow(prizeId))?.state).toBe('queued')
  })
})
