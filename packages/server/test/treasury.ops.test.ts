// Covers the two things a host and an operator touch: the treasury health page, and the
// command that puts a failed payout back in the queue or writes it off. It does NOT cover
// the listener's socket (the body is built and read directly here), and it does NOT cover
// the export command's file writing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, type Claim } from '../src/db/schema.js'
import { parseRequeueArguments, runRequeue } from '../src/cli/requeue.js'
import { createStatus, healthBody, oldestQueuedAgeSeconds } from '../src/treasury/health.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const ADDRESS = 'NQ92CT8X1RXLE18507TVJFHA7JF1CG4LBHV7'

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

async function queueClaim(state: string, at: Date = NOW): Promise<Claim> {
  const [row] = await db
    .insert(claims)
    .values({
      address: player,
      questId: null,
      kind: 'ladder',
      amountLuna: 50_000n,
      state,
      memo: `vettai:ladder:${at.getTime()}`,
      createdAt: at,
      attempts: 3,
      txHash: state === 'failed' ? 'a'.repeat(64) : null,
      validityStartHeight: state === 'failed' ? 11_500_000 : null,
      error: state === 'failed' ? 'the node never accepted it' : null,
    })
    .returning()

  if (!row) throw new Error('could not write the test claim')
  return row
}

describe('the treasury health page', () => {
  it('is only ok when the node answers and the wallet covers what is promised', async () => {
    const status = createStatus('TestAlbatross', ADDRESS)

    expect((await healthBody(status, NOW)).ok).toBe(false)

    status.nodeOk = true
    status.balanceLuna = 100_000n
    status.committedLuna = 150_000n
    status.db = db
    status.lastOutboxPassAt = NOW
    status.lastWatcherPassAt = NOW

    const short = await healthBody(status, NOW)
    expect(short).toMatchObject({
      ok: false,
      network: 'TestAlbatross',
      address: ADDRESS,
      balanceNim: '1',
      committedNim: '1.5',
      nodeOk: true,
      oldestQueuedAgeSeconds: null,
    })
    expect(short.lastOutboxPassAt).toBe(NOW.toISOString())

    status.balanceLuna = 150_000n
    expect((await healthBody(status, NOW)).ok).toBe(true)

    status.nodeOk = false
    expect((await healthBody(status, NOW)).ok).toBe(false)
  })

  it('says how long the oldest payout has been waiting to leave', async () => {
    expect(await oldestQueuedAgeSeconds(db, NOW)).toBeNull()

    await queueClaim('paid', new Date(NOW.getTime() - 3 * 60 * 60 * 1000))
    expect(await oldestQueuedAgeSeconds(db, NOW)).toBeNull()

    await queueClaim('queued', new Date(NOW.getTime() - 90_000))
    await queueClaim('sent', new Date(NOW.getTime() - 30_000))

    expect(await oldestQueuedAgeSeconds(db, NOW)).toBe(90)
  })
})

describe('treasury:requeue', () => {
  it('reads the claim and the one flag, and refuses anything else', () => {
    const id = '4f1c2a7e-5b6d-4e3a-9c2f-8a1b2c3d4e5f'
    expect(parseRequeueArguments(['--claim', id])).toEqual({ claimId: id, cancel: false })
    expect(parseRequeueArguments(['--claim', id, '--cancel'])).toEqual({ claimId: id, cancel: true })
    expect(() => parseRequeueArguments([])).toThrow(/--claim is required/)
    expect(() => parseRequeueArguments(['--claim'])).toThrow(/needs the id/)
    expect(() => parseRequeueArguments(['--calim', 'abc'])).toThrow(/not an option/)
    expect(() => parseRequeueArguments(['--claim', 'not-a-claim'])).toThrow(/not a claim id/)
  })

  it('puts a failed payout back in the queue with a clean slate', async () => {
    const claim = await queueClaim('failed')
    const lines: string[] = []

    const code = await runRequeue({ db, args: { claimId: claim.id, cancel: false }, say: (line) => lines.push(line) })

    expect(code).toBe(0)
    expect(lines.some((line) => line.includes(claim.id))).toBe(true)
    expect(lines.some((line) => line.includes('0.5 NIM'))).toBe(true)

    const [row] = await db.select().from(claims).where(eq(claims.id, claim.id))
    expect(row).toMatchObject({ state: 'queued', txHash: null, attempts: 0, validityStartHeight: null })
  })

  it('cancels a payout that is never going to be made, and touches nothing else', async () => {
    const claim = await queueClaim('failed')
    const queued = await queueClaim('queued', new Date(NOW.getTime() + 1000))
    const lines: string[] = []

    expect(await runRequeue({ db, args: { claimId: claim.id, cancel: true }, say: (line) => lines.push(line) })).toBe(0)
    expect((await db.select().from(claims).where(eq(claims.id, claim.id)))[0]?.state).toBe('cancelled')

    // Only a failed payout is moved by hand: anything else is the treasury's business.
    const refused = await runRequeue({ db, args: { claimId: queued.id, cancel: false }, say: (line) => lines.push(line) })
    expect(refused).toBe(1)
    expect((await db.select().from(claims).where(eq(claims.id, queued.id)))[0]?.state).toBe('queued')

    expect(await runRequeue({ db, args: { claimId: 'not-a-claim', cancel: false }, say: (line) => lines.push(line) })).toBe(1)
  })
})
