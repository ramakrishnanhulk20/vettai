// Covers the delivery loop: the order payouts leave in, the gap between them, what
// happens to a payout when the treasury dies in the middle of sending it, and what
// happens to one the node refused after the hash was already written down. It does NOT
// cover the real network (the node here lives in this process), and it does NOT cover two
// treasury processes running at once, which the state row is meant to survive but which
// PGlite cannot be made to do.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { PrivateKey } from '@nimiq/core'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, statsDaily, type Claim } from '../src/db/schema.js'
import { deliverOnce, REJECTED_MS, SEND_SPACING_MS, STALE_MS } from '../src/treasury/outbox.js'
import { createSender, type SendInput, type Sender } from '../src/treasury/sender.js'
import { clearTables, freshDb, insertPlayer, randomAddress } from './support/db.js'
import { FakeRpc } from './support/fakeRpc.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const KEY_HEX = PrivateKey.generate().toHex()

let handle: DbHandle
let db: Db
let rpc: FakeRpc

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
  rpc.includeAfter = 0
})

type Watched = Sender & { sends: { to: string; memo: string; at: number }[] }

function watchedSender(options: { crashAfterBroadcast?: boolean; failBeforeSigning?: boolean } = {}): Watched {
  const real = createSender({ privateKeyHex: KEY_HEX, network: 'TestAlbatross', rpc, pollMs: 1 })
  const sends: { to: string; memo: string; at: number }[] = []

  return {
    sends,
    address: real.address,
    async send(input: SendInput) {
      sends.push({ to: input.to, memo: input.memo, at: Date.now() })
      if (options.failBeforeSigning) throw new Error('the node did not answer')

      const result = await real.send(input)
      if (options.crashAfterBroadcast) throw new Error('the treasury died after broadcasting')
      return result
    },
    waitInclusion: (hash, timeoutMs) => real.waitInclusion(hash, timeoutMs),
    lookup: (hash) => real.lookup(hash),
  }
}

async function queueClaims(count: number, amountLuna = 50_000n): Promise<string[]> {
  const ids: string[] = []

  for (let index = 0; index < count; index += 1) {
    const { address } = await insertPlayer(db, randomAddress())
    const [row] = await db
      .insert(claims)
      .values({
        address,
        questId: null,
        kind: 'ladder',
        amountLuna,
        memo: `vettai:ladder:2026-W${10 + index}`,
        createdAt: new Date(NOW.getTime() + index * 1000),
      })
      .returning({ id: claims.id })

    if (!row) throw new Error('could not queue the test claim')
    ids.push(row.id)
  }

  return ids
}

function claimById(id: string): Promise<Claim | undefined> {
  return db
    .select()
    .from(claims)
    .where(eq(claims.id, id))
    .limit(1)
    .then((rows) => rows[0])
}

describe('deliverOnce', () => {
  it('pays the oldest first, one at a time, with a gap between sends', async () => {
    const ids = await queueClaims(3)
    const sender = watchedSender()

    vi.useFakeTimers({ now: NOW })
    try {
      const running = deliverOnce(db, sender, NOW, { inclusionMs: 0 })
      await vi.advanceTimersByTimeAsync(10_000)
      const summary = await running

      expect(summary).toMatchObject({ sent: 3, paid: 3, failed: 0 })
    } finally {
      vi.useRealTimers()
    }

    expect(sender.sends.map((send) => send.memo)).toEqual([
      'vettai:ladder:2026-W10',
      'vettai:ladder:2026-W11',
      'vettai:ladder:2026-W12',
    ])

    const gaps = sender.sends.slice(1).map((send, index) => send.at - (sender.sends[index]?.at ?? 0))
    expect(gaps.every((gap) => gap >= SEND_SPACING_MS)).toBe(true)

    for (const id of ids) {
      const row = await claimById(id)
      expect(row?.state).toBe('paid')
      expect(row?.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row?.blockNumber).toBe(rpc.head)
    }
  })

  it('never sends a payout twice when the treasury dies after broadcasting', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    const crashing = watchedSender({ crashAfterBroadcast: true })
    await deliverOnce(db, crashing, NOW, { spacingMs: 0, inclusionMs: 0 })

    const afterCrash = await claimById(id)
    expect(afterCrash?.state).toBe('sending')
    expect(afterCrash?.txHash).toBe(rpc.pushed[0]?.hash)
    expect(rpc.pushed).toHaveLength(1)

    const recovered = watchedSender()
    const summary = await deliverOnce(db, recovered, new Date(NOW.getTime() + 2000), {
      spacingMs: 0,
      inclusionMs: 0,
    })

    expect(recovered.sends).toHaveLength(0)
    expect(rpc.pushed).toHaveLength(1)
    expect(summary).toMatchObject({ sent: 0, paid: 1 })

    const settled = await claimById(id)
    expect(settled?.state).toBe('paid')
    expect(settled?.blockNumber).toBe(rpc.head)
  })

  it('tries a payout that never reached a signature once more, then gives up on it', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    const broken = watchedSender({ failBeforeSigning: true })
    await deliverOnce(db, broken, NOW, { spacingMs: 0, inclusionMs: 0 })

    const stuck = await claimById(id)
    expect(stuck?.state).toBe('sending')
    expect(stuck?.txHash).toBeNull()
    expect(rpc.pushed).toHaveLength(0)

    const tenMinutesOn = new Date(NOW.getTime() + STALE_MS + 1000)
    await deliverOnce(db, broken, tenMinutesOn, { spacingMs: 0, inclusionMs: 0 })

    const retried = await claimById(id)
    expect(retried?.attempts).toBe(1)

    const later = new Date(tenMinutesOn.getTime() + STALE_MS + 1000)
    const summary = await deliverOnce(db, broken, later, { spacingMs: 0, inclusionMs: 0 })

    expect(summary.failed).toBe(1)
    expect((await claimById(id))?.state).toBe('failed')
    expect(rpc.pushed).toHaveLength(0)
  })

  it('rebuilds a payout the node refused, once the hash is old enough to be certain', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    rpc.failPush = 'rejected: transaction is invalid'
    const refused = watchedSender()
    await deliverOnce(db, refused, NOW, { spacingMs: 0, inclusionMs: 0 })

    const broadcast = await claimById(id)
    expect(broadcast?.state).toBe('sending')
    expect(broadcast?.txHash).toMatch(/^[0-9a-f]{64}$/)
    expect(rpc.pushed).toHaveLength(0)

    const tooSoon = await deliverOnce(db, refused, new Date(NOW.getTime() + 60_000), {
      spacingMs: 0,
      inclusionMs: 0,
    })
    expect(tooSoon).toMatchObject({ sent: 0, paid: 0, failed: 0 })
    expect((await claimById(id))?.txHash).toBe(broadcast?.txHash)

    rpc.failPush = null
    const later = new Date(NOW.getTime() + REJECTED_MS + 1000)
    const summary = await deliverOnce(db, watchedSender(), later, { spacingMs: 0, inclusionMs: 0 })

    expect(summary).toMatchObject({ sent: 1, paid: 1 })
    expect(rpc.pushed).toHaveLength(1)

    const paid = await claimById(id)
    expect(paid?.state).toBe('paid')
    expect(paid?.attempts).toBe(1)
    expect(paid?.txHash).toBe(rpc.pushed[0]?.hash)
  })

  it('gives up on a payout the node refused three times', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    rpc.failPush = 'rejected: transaction is invalid'
    const refused = watchedSender()

    let at = NOW
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliverOnce(db, refused, at, { spacingMs: 0, inclusionMs: 0 })
      at = new Date(at.getTime() + REJECTED_MS + 1000)
      await deliverOnce(db, refused, at, { spacingMs: 0, inclusionMs: 0 })
    }

    const row = await claimById(id)
    expect(row?.state).toBe('failed')
    expect(row?.attempts).toBe(3)
    expect(row?.error).toMatch(/never accepted/)
    expect(rpc.pushed).toHaveLength(0)
  })

  it('never resends a payout because the node could not answer', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    rpc.includeAfter = 99
    const sender = watchedSender()
    await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })

    const broadcast = await claimById(id)
    expect(broadcast?.state).toBe('sent')

    rpc.failLookups = true
    const later = new Date(NOW.getTime() + REJECTED_MS + 1000)
    const summary = await deliverOnce(db, sender, later, { spacingMs: 0, inclusionMs: 0 })

    expect(summary).toMatchObject({ sent: 0, paid: 0, failed: 0 })
    expect(rpc.pushed).toHaveLength(1)

    const row = await claimById(id)
    expect(row?.state).toBe('sent')
    expect(row?.txHash).toBe(broadcast?.txHash)
    expect(row?.attempts).toBe(0)
  })

  it('takes at most five payouts in one pass', async () => {
    await queueClaims(7)
    const sender = watchedSender()

    const summary = await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })

    expect(summary.sent).toBe(5)
    expect(sender.sends).toHaveLength(5)

    const rows = await db.select().from(claims).orderBy(asc(claims.createdAt))
    expect(rows.filter((row) => row.state === 'queued')).toHaveLength(2)
    expect(rows.slice(5).every((row) => row.state === 'queued')).toBe(true)
  })

  it('adds a paid payout to the day it left, and a failed one to nothing', async () => {
    const [paidId] = await queueClaims(1, 70_000n)
    if (!paidId) throw new Error('no claim to deliver')

    await deliverOnce(db, watchedSender(), NOW, { spacingMs: 0, inclusionMs: 0 })
    expect((await claimById(paidId))?.state).toBe('paid')

    const [afterPaid] = await db.select().from(statsDaily)
    expect(afterPaid?.day).toBe('2026-09-15')
    expect(afterPaid?.paidLuna).toBe(70_000n)

    const [failingId] = await queueClaims(1, 40_000n)
    if (!failingId) throw new Error('no second claim to deliver')

    const broken = watchedSender({ failBeforeSigning: true })
    await deliverOnce(db, broken, NOW, { spacingMs: 0, inclusionMs: 0 })
    await deliverOnce(db, broken, new Date(NOW.getTime() + STALE_MS + 1000), { spacingMs: 0, inclusionMs: 0 })
    await deliverOnce(db, broken, new Date(NOW.getTime() + 2 * STALE_MS + 2000), {
      spacingMs: 0,
      inclusionMs: 0,
    })

    expect((await claimById(failingId))?.state).toBe('failed')

    const rows = await db.select().from(statsDaily)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.paidLuna).toBe(70_000n)
  })

  it('leaves a broadcast payout as sent until a block carries it', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')
    rpc.includeAfter = 5

    const sender = watchedSender()
    const first = await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })

    expect(first).toMatchObject({ sent: 1, paid: 0 })
    expect((await claimById(id))?.state).toBe('sent')

    rpc.includeAfter = 0
    const second = await deliverOnce(db, sender, new Date(NOW.getTime() + 2000), {
      spacingMs: 0,
      inclusionMs: 0,
    })

    expect(second).toMatchObject({ sent: 0, paid: 1 })
    expect(sender.sends).toHaveLength(1)
    expect((await claimById(id))?.state).toBe('paid')
  })
})
