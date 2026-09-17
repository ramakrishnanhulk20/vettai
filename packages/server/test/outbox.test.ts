// Covers the delivery loop: the order payouts leave in, the gap between them, what happens
// to a payout when the treasury dies in the middle of sending it, what happens to one the
// node refused after the hash was already written down, when a payment counts as final, and
// the wallet check that stops the treasury promising more than it holds. It does NOT cover
// the real network (the node here lives in this process), and it does NOT cover two treasury
// processes running at once, which the state row is meant to survive but which PGlite cannot
// be made to do.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { PrivateKey } from '@nimiq/core'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, statsDaily, type Claim } from '../src/db/schema.js'
import {
  deliverOnce,
  FIRST_BACKOFF_MS,
  REJECTED_MS,
  SEND_SPACING_MS,
  STALE_MS,
} from '../src/treasury/outbox.js'
import {
  createSender,
  FINALITY_BLOCKS,
  VALIDITY_WINDOW_BLOCKS,
  type SendInput,
  type Sender,
} from '../src/treasury/sender.js'
import { clearTables, freshDb, insertPlayer, randomAddress, randomHash } from './support/db.js'
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
    head: () => real.head(),
    balanceLuna: () => real.balanceLuna(),
    mempoolHas: (hash) => real.mempoolHas(hash),
    outgoingSince: (sinceBlock) => real.outgoingSince(sinceBlock),
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

/** What a later pass sees once the chain has buried the payments this pass broadcast. */
async function passAfterFinality(sender: Sender, at: Date = new Date(NOW.getTime() + 2000)) {
  rpc.mine(FINALITY_BLOCKS)
  return deliverOnce(db, sender, at, { spacingMs: 0, inclusionMs: 0 })
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

      expect(summary).toMatchObject({ sent: 3, paid: 0, failed: 0 })
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

    const block = rpc.head
    expect((await passAfterFinality(sender)).paid).toBe(3)

    for (const id of ids) {
      const row = await claimById(id)
      expect(row?.state).toBe('paid')
      expect(row?.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row?.blockNumber).toBe(block)
      expect(row?.validityStartHeight).toBe(block)
    }
  })

  it('waits for a full batch on top of the block before it calls a payout paid', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    const sender = watchedSender()
    await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })

    const block = rpc.head
    const shallow = await claimById(id)
    expect(shallow?.state).toBe('sent')
    expect(shallow?.blockNumber).toBe(block)

    rpc.mine(10)
    const tooSoon = await deliverOnce(db, sender, new Date(NOW.getTime() + 2000), {
      spacingMs: 0,
      inclusionMs: 0,
    })
    expect(tooSoon.paid).toBe(0)
    expect((await claimById(id))?.state).toBe('sent')

    rpc.mine(FINALITY_BLOCKS - 10 + 1)
    const deep = await deliverOnce(db, sender, new Date(NOW.getTime() + 4000), {
      spacingMs: 0,
      inclusionMs: 0,
    })

    expect(deep.paid).toBe(1)
    expect(sender.sends).toHaveLength(1)

    const paid = await claimById(id)
    expect(paid?.state).toBe('paid')
    expect(paid?.blockNumber).toBe(block)
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
    const block = rpc.head
    const found = await deliverOnce(db, recovered, new Date(NOW.getTime() + 2000), {
      spacingMs: 0,
      inclusionMs: 0,
    })

    expect(found.paid).toBe(0)
    expect((await claimById(id))?.blockNumber).toBe(block)

    const summary = await passAfterFinality(recovered, new Date(NOW.getTime() + 4000))

    expect(recovered.sends).toHaveLength(0)
    expect(rpc.pushed).toHaveLength(1)
    expect(summary).toMatchObject({ sent: 0, paid: 1 })

    const settled = await claimById(id)
    expect(settled?.state).toBe('paid')
    expect(settled?.blockNumber).toBe(block)
  })

  it('waits and tries again, without spending an attempt, when a payout never reached a signature', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    const broken = watchedSender({ failBeforeSigning: true })
    await deliverOnce(db, broken, NOW, { spacingMs: 0, inclusionMs: 0 })

    const waiting = await claimById(id)
    expect(waiting?.state).toBe('queued')
    expect(waiting?.txHash).toBeNull()
    expect(waiting?.attempts).toBe(0)
    expect(waiting?.nextAttemptAt?.getTime()).toBe(NOW.getTime() + FIRST_BACKOFF_MS)
    expect(rpc.pushed).toHaveLength(0)

    // Nothing leaves while the backoff is running, and nothing is failed either: the money
    // is owed whatever the node is doing.
    const tooSoon = await deliverOnce(db, broken, new Date(NOW.getTime() + 1000), {
      spacingMs: 0,
      inclusionMs: 0,
    })
    expect(tooSoon).toMatchObject({ sent: 0, failed: 0 })
    expect(broken.sends).toHaveLength(1)

    const later = new Date(NOW.getTime() + FIRST_BACKOFF_MS + 1000)
    await deliverOnce(db, broken, later, { spacingMs: 0, inclusionMs: 0 })

    const second = await claimById(id)
    expect(broken.sends).toHaveLength(2)
    expect(second?.attempts).toBe(0)
    expect(second?.nextAttemptAt?.getTime()).toBe(later.getTime() + 2 * FIRST_BACKOFF_MS)
  })

  it('rebuilds a payout the node refused, once the chain can no longer take it', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    rpc.failPush = 'rejected: transaction is invalid'
    const refused = watchedSender()
    await deliverOnce(db, refused, NOW, { spacingMs: 0, inclusionMs: 0 })

    const broadcast = await claimById(id)
    expect(broadcast?.state).toBe('sending')
    expect(broadcast?.txHash).toMatch(/^[0-9a-f]{64}$/)
    expect(broadcast?.validityStartHeight).toBe(rpc.head)
    expect(rpc.pushed).toHaveLength(0)

    // Old enough, but the chain could still accept that transaction, so it is left alone.
    const oldEnough = new Date(NOW.getTime() + REJECTED_MS + 1000)
    const tooSoon = await deliverOnce(db, refused, oldEnough, { spacingMs: 0, inclusionMs: 0 })
    expect(tooSoon).toMatchObject({ sent: 0, paid: 0, failed: 0 })
    expect((await claimById(id))?.txHash).toBe(broadcast?.txHash)

    rpc.failPush = null
    rpc.mine(VALIDITY_WINDOW_BLOCKS + FINALITY_BLOCKS + 1)
    const summary = await deliverOnce(db, watchedSender(), oldEnough, { spacingMs: 0, inclusionMs: 0 })

    expect(summary.sent).toBe(1)
    expect(rpc.pushed).toHaveLength(1)

    const rebuilt = await claimById(id)
    expect(rebuilt?.state).toBe('sent')
    expect(rebuilt?.attempts).toBe(1)
    expect(rebuilt?.txHash).toBe(rpc.pushed[0]?.hash)
  })

  it('never rebuilds a hash the node is still holding in its mempool', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    // The node takes the broadcast and then answers "not found" for it, which is exactly what
    // rpc.nimiqwatch.com does for a transaction sitting in its own mempool.
    rpc.includeAfter = 10_000
    const sender = watchedSender()
    await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })

    const broadcast = await claimById(id)
    expect(rpc.pushed).toHaveLength(1)
    expect(rpc.mempool.has(broadcast?.txHash ?? '')).toBe(true)

    rpc.mine(VALIDITY_WINDOW_BLOCKS + FINALITY_BLOCKS + 1)
    const later = new Date(NOW.getTime() + REJECTED_MS + 1000)
    const summary = await deliverOnce(db, sender, later, { spacingMs: 0, inclusionMs: 0 })

    expect(summary).toMatchObject({ sent: 0, paid: 0, failed: 0 })
    expect(rpc.pushed).toHaveLength(1)

    const row = await claimById(id)
    expect(row?.state).toBe('sent')
    expect(row?.txHash).toBe(broadcast?.txHash)
    expect(row?.attempts).toBe(0)
  })

  it('closes a payout the treasury already made, read off its own history, without sending again', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    rpc.includeAfter = 10_000
    const sender = watchedSender()
    await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })

    const broadcast = await claimById(id)
    const start = broadcast?.validityStartHeight ?? 0

    // The node has forgotten the hash and lost it from the mempool, but the payment is there
    // in the treasury's own outgoing history, under the memo the claim was queued with.
    rpc.mempool.clear()
    const onChain = rpc.place({
      hash: randomHash(),
      sender: sender.address,
      recipient: broadcast?.address ?? '',
      valueLuna: broadcast?.amountLuna ?? 0n,
      memo: broadcast?.memo ?? '',
      blockNumber: start + 10,
    })

    rpc.mine(VALIDITY_WINDOW_BLOCKS + FINALITY_BLOCKS + 1)
    const later = new Date(NOW.getTime() + REJECTED_MS + 1000)
    const summary = await deliverOnce(db, sender, later, { spacingMs: 0, inclusionMs: 0 })

    expect(summary).toMatchObject({ sent: 0, paid: 1 })
    expect(rpc.pushed).toHaveLength(1)
    expect(sender.sends).toHaveLength(1)

    const row = await claimById(id)
    expect(row?.state).toBe('paid')
    expect(row?.txHash).toBe(onChain.hash)
    expect(row?.blockNumber).toBe(onChain.blockNumber)
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
      rpc.mine(VALIDITY_WINDOW_BLOCKS + FINALITY_BLOCKS + 1)
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
    rpc.mine(VALIDITY_WINDOW_BLOCKS + FINALITY_BLOCKS + 1)
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

  it('adds a payout to the day it was confirmed, and one that never left to nothing', async () => {
    const [paidId] = await queueClaims(1, 70_000n)
    if (!paidId) throw new Error('no claim to deliver')

    const sender = watchedSender()
    await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })
    await passAfterFinality(sender)
    expect((await claimById(paidId))?.state).toBe('paid')

    const [afterPaid] = await db.select().from(statsDaily)
    expect(afterPaid?.day).toBe('2026-09-15')
    expect(afterPaid?.paidLuna).toBe(70_000n)

    const [waitingId] = await queueClaims(1, 40_000n)
    if (!waitingId) throw new Error('no second claim to deliver')

    const broken = watchedSender({ failBeforeSigning: true })
    await deliverOnce(db, broken, NOW, { spacingMs: 0, inclusionMs: 0 })

    expect((await claimById(waitingId))?.state).toBe('queued')

    const rows = await db.select().from(statsDaily)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.paidLuna).toBe(70_000n)
  })

  it('leaves a claim queued with a backoff when the node answers a send with a 503', async () => {
    const [id] = await queueClaims(1)
    if (!id) throw new Error('no claim to deliver')

    rpc.failBlockNumber = 'Service Unavailable'
    const sender = watchedSender()
    const summary = await deliverOnce(db, sender, NOW, { spacingMs: 0, inclusionMs: 0 })

    expect(summary).toMatchObject({ sent: 0, failed: 0 })
    expect(rpc.pushed).toHaveLength(0)

    const row = await claimById(id)
    expect(row?.state).toBe('queued')
    expect(row?.attempts).toBe(0)
    expect(row?.txHash).toBeNull()
    expect(row?.nextAttemptAt?.getTime()).toBe(NOW.getTime() + FIRST_BACKOFF_MS)
    expect(row?.error).toMatch(/before signing/)

    rpc.failBlockNumber = null
    const later = new Date(NOW.getTime() + FIRST_BACKOFF_MS + 1000)
    const recovered = await deliverOnce(db, sender, later, { spacingMs: 0, inclusionMs: 0 })

    expect(recovered.sent).toBe(1)
    expect((await claimById(id))?.state).toBe('sent')
    expect((await claimById(id))?.nextAttemptAt).toBeNull()
  })

  it('sends nothing while the wallet holds less than it has promised, and resumes when it is topped up', async () => {
    const ids = await queueClaims(2, 50_000n)
    const sender = watchedSender()
    const lines: string[] = []

    // 100,000 luna is committed and the next payout is 50,000 of it, so the wallet has to
    // hold 150,000 before anything is signed.
    rpc.balanceLuna = 149_999n
    const short = new Date(NOW.getTime() + 60 * 60 * 1000)
    const held = await deliverOnce(db, sender, short, {
      spacingMs: 0,
      inclusionMs: 0,
      log: (line) => lines.push(line),
    })

    expect(held).toMatchObject({ sent: 0, balanceLuna: 149_999n, committedLuna: 100_000n })
    expect(rpc.pushed).toHaveLength(0)
    expect(lines.some((line) => line.startsWith('wallet below committed'))).toBe(true)
    for (const id of ids) expect((await claimById(id))?.state).toBe('queued')

    rpc.balanceLuna = 150_000n
    const paid = await deliverOnce(db, sender, new Date(short.getTime() + 1000), {
      spacingMs: 0,
      inclusionMs: 0,
    })

    expect(paid.sent).toBe(2)
    expect(rpc.pushed).toHaveLength(2)
  })
})
