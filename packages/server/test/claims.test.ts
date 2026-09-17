// Covers the one path that turns a finished quest into a queued payout: the memo, the
// three caps, and the "a quest pays once" rule. It does NOT cover the claim endpoint or
// the signature check in front of it, and it does NOT send anything: the treasury side
// is proven in outbox.test.ts and sender.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { dailyCapLuna } from '../src/config.js'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, quests } from '../src/db/schema.js'
import { claimTotals, listClaims, queueClaim } from '../src/domain/claims.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer, randomAddress } from './support/db.js'

const DAY = '2026-09-15'
const NOW = new Date('2026-09-15T10:00:00Z')

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

async function newQuest(address: string, kind = 'hunt', day = DAY): Promise<string> {
  const [row] = await db
    .insert(quests)
    .values({ address, day, kind, target: 5, state: 'done', rewardLuna: nimToLuna('0.5') })
    .returning({ id: quests.id })

  if (!row) throw new Error('could not insert the test quest')
  return row.id
}

describe('queueClaim', () => {
  it('queues a finished quest with the quest id in the memo', async () => {
    const questId = await newQuest(player)

    const result = await queueClaim(db, {
      address: player,
      questId,
      kind: 'hunt',
      amountLuna: nimToLuna('0.5'),
      ipHash: 'ip-a',
      now: NOW,
    })

    expect(result).toEqual({ state: 'queued', claimId: expect.any(String) })

    const [row] = await db.select().from(claims).where(eq(claims.questId, questId))
    expect(row?.state).toBe('queued')
    expect(row?.memo).toBe(`vettai:${questId.slice(0, 8)}`)
    expect(row?.amountLuna).toBe(nimToLuna('0.5'))
    expect(row?.error).toBeNull()
  })

  it('holds a wallet that has had its day, with the reason on the row', async () => {
    const first = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'hunt'),
      kind: 'hunt',
      amountLuna: dailyCapLuna,
      now: NOW,
    })
    expect(first.state).toBe('queued')

    const held = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'courier'),
      kind: 'courier',
      amountLuna: nimToLuna('0.3'),
      now: NOW,
    })

    expect(held).toMatchObject({ state: 'held', reason: 'daily cap' })

    const [row] = await db.select().from(claims).where(eq(claims.id, held.claimId))
    expect(row?.state).toBe('held')
    expect(row?.error).toBe('daily cap')
  })

  it('starts the wallet fresh on the next UTC day', async () => {
    await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'hunt'),
      kind: 'hunt',
      amountLuna: dailyCapLuna,
      now: NOW,
    })

    const tomorrow = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'hunt', '2026-09-16'),
      kind: 'hunt',
      amountLuna: nimToLuna('0.5'),
      now: new Date('2026-09-16T00:30:00Z'),
    })

    expect(tomorrow.state).toBe('queued')
  })

  it('holds the third wallet claiming from one house today', async () => {
    const others = [randomAddress(), randomAddress()]
    for (const address of others) {
      await insertPlayer(db, address)
      await queueClaim(db, {
        address,
        questId: await newQuest(address),
        kind: 'hunt',
        amountLuna: nimToLuna('0.5'),
        ipHash: 'one-house',
        now: NOW,
      })
    }

    const third = await queueClaim(db, {
      address: player,
      questId: await newQuest(player),
      kind: 'hunt',
      amountLuna: nimToLuna('0.5'),
      ipHash: 'one-house',
      now: NOW,
    })

    expect(third).toMatchObject({ state: 'held', reason: 'ip cap' })

    const elsewhere = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'courier'),
      kind: 'courier',
      amountLuna: nimToLuna('0.3'),
      ipHash: 'another-house',
      now: NOW,
    })
    expect(elsewhere.state).toBe('queued')
  })

  it('counts only the wallets that were granted something towards the house', async () => {
    const limits = { dailyCapLuna: nimToLuna('0.5'), ipWalletsPerDay: 2 }

    const heldWallet = randomAddress()
    await insertPlayer(db, heldWallet)
    const refused = await queueClaim(db, {
      address: heldWallet,
      questId: await newQuest(heldWallet),
      kind: 'hunt',
      amountLuna: nimToLuna('0.6'),
      ipHash: 'one-house',
      now: NOW,
      limits,
    })
    expect(refused).toMatchObject({ state: 'held', reason: 'daily cap' })

    const granted = randomAddress()
    await insertPlayer(db, granted)
    const allowed = await queueClaim(db, {
      address: granted,
      questId: await newQuest(granted),
      kind: 'hunt',
      amountLuna: nimToLuna('0.4'),
      ipHash: 'one-house',
      now: NOW,
      limits,
    })
    expect(allowed.state).toBe('queued')

    const third = await queueClaim(db, {
      address: player,
      questId: await newQuest(player),
      kind: 'hunt',
      amountLuna: nimToLuna('0.4'),
      ipHash: 'one-house',
      now: NOW,
      limits,
    })

    expect(third.state).toBe('queued')
  })

  it('holds everything once the pool is spent', async () => {
    const limits = { poolTotalLuna: nimToLuna('1') }

    const inside = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'hunt'),
      kind: 'hunt',
      amountLuna: nimToLuna('0.9'),
      now: NOW,
      limits,
    })
    expect(inside.state).toBe('queued')

    const over = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'courier'),
      kind: 'courier',
      amountLuna: nimToLuna('0.3'),
      now: NOW,
      limits,
    })

    expect(over).toMatchObject({ state: 'held', reason: 'pool' })
  })

  it('keeps a failed payout inside the pool, because it is still owed', async () => {
    const limits = { poolTotalLuna: nimToLuna('1') }

    const first = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'hunt'),
      kind: 'hunt',
      amountLuna: nimToLuna('0.9'),
      now: NOW,
      limits,
    })
    await db.update(claims).set({ state: 'failed' }).where(eq(claims.id, first.claimId))

    const next = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'courier'),
      kind: 'courier',
      amountLuna: nimToLuna('0.3'),
      now: NOW,
      limits,
    })

    expect(next).toMatchObject({ state: 'held', reason: 'pool' })
    expect((await claimTotals(db)).committedLuna).toBe(nimToLuna('0.9'))

    // Cancelling is the one thing that gives the room back, and it is a person's decision.
    await db.update(claims).set({ state: 'cancelled' }).where(eq(claims.id, first.claimId))
    expect((await claimTotals(db)).committedLuna).toBe(0n)

    const after = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'landmarks'),
      kind: 'landmarks',
      amountLuna: nimToLuna('0.3'),
      now: NOW,
      limits,
    })
    expect(after.state).toBe('queued')
  })

  it('pays one quest once, however many times it is claimed', async () => {
    const questId = await newQuest(player)
    const input = {
      address: player,
      questId,
      kind: 'hunt' as const,
      amountLuna: nimToLuna('0.5'),
      now: NOW,
    }

    const first = await queueClaim(db, input)
    const second = await queueClaim(db, input)

    expect(first.state).toBe('queued')
    expect(second).toEqual({ state: 'refused', claimId: first.claimId, reason: 'already claimed' })

    const rows = await db.select().from(claims).where(eq(claims.questId, questId))
    expect(rows).toHaveLength(1)
  })

  it('refuses an amount that is not money', async () => {
    await expect(
      queueClaim(db, { address: player, questId: null, kind: 'ladder', amountLuna: 0n, memo: 'x', now: NOW }),
    ).rejects.toThrow(/more than nothing/)
  })

  it('makes a ladder prize bring its own memo', async () => {
    await expect(
      queueClaim(db, { address: player, questId: null, kind: 'ladder', amountLuna: 100n, now: NOW }),
    ).rejects.toThrow(/bring its own memo/)
  })
})

describe('listClaims and claimTotals', () => {
  it('reports the claims of one wallet and the pool, from the rows themselves', async () => {
    const paid = await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'hunt'),
      kind: 'hunt',
      amountLuna: nimToLuna('0.5'),
      now: NOW,
    })
    await db.update(claims).set({ state: 'paid', paidAt: NOW }).where(eq(claims.id, paid.claimId))

    await queueClaim(db, {
      address: player,
      questId: await newQuest(player, 'courier'),
      kind: 'courier',
      amountLuna: nimToLuna('0.3'),
      now: NOW,
    })

    const mine = await listClaims(db, player)
    expect(mine).toHaveLength(2)
    expect(await listClaims(db, randomAddress())).toHaveLength(0)

    const totals = await claimTotals(db)
    expect(totals.paidLuna).toBe(nimToLuna('0.5'))
    expect(totals.paidCount).toBe(1)
    expect(totals.committedLuna).toBe(nimToLuna('0.8'))
    expect(totals.queuedCount).toBe(1)
    expect(totals.heldCount).toBe(0)
  })
})
