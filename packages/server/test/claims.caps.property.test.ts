// Covers the money promise behind the caps: whatever order claims arrive in, a wallet
// never has more than the daily cap committed on one UTC day and Vettai never commits
// more than the pool. It does NOT cover the IP cap (that one is a count of wallets, not
// an amount, and it is proven in claims.test.ts), and it does NOT cover claims arriving
// in parallel: claims.race.test.ts does that.

import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims } from '../src/db/schema.js'
import { queueClaim, type Limits } from '../src/domain/claims.js'
import { utcDayStart } from '../src/lib/day.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'

const LIMITS: Limits = { dailyCapLuna: 100_000n, poolTotalLuna: 300_000n, ipWalletsPerDay: 99 }

const DAYS = ['2026-09-15T08:00:00Z', '2026-09-16T08:00:00Z']

let handle: DbHandle
let db: Db
let wallets: string[]

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
  await clearTables(db)
  wallets = [(await insertPlayer(db)).address, (await insertPlayer(db)).address, (await insertPlayer(db)).address]
}, 60_000)

afterAll(async () => {
  await handle.close()
})

type Attempt = { wallet: number; day: number; amountLuna: number }

const attempts = fc.array(
  fc.record({
    wallet: fc.integer({ min: 0, max: 2 }),
    day: fc.integer({ min: 0, max: 1 }),
    amountLuna: fc.integer({ min: 1_000, max: 60_000 }),
  }),
  { minLength: 1, maxLength: 12 },
)

describe('the caps hold whatever the sequence', () => {
  it('never commits more than the daily cap per wallet per day, or more than the pool', async () => {
    await fc.assert(
      fc.asyncProperty(attempts, async (sequence: Attempt[]) => {
        await db.delete(claims)

        for (const [index, attempt] of sequence.entries()) {
          const now = new Date(DAYS[attempt.day] ?? DAYS[0] ?? '')
          await queueClaim(db, {
            address: wallets[attempt.wallet] ?? '',
            questId: null,
            kind: 'ladder',
            amountLuna: BigInt(attempt.amountLuna),
            memo: `vettai:test:${index}`,
            now,
            limits: LIMITS,
          })
        }

        const rows = await db.select().from(claims)

        const committed = rows.filter((row) => row.state !== 'held')
        const perWalletPerDay = new Map<string, bigint>()
        let pool = 0n

        for (const row of committed) {
          const key = `${row.address}:${utcDayStart(row.createdAt).toISOString()}`
          perWalletPerDay.set(key, (perWalletPerDay.get(key) ?? 0n) + row.amountLuna)
          pool += row.amountLuna
        }

        for (const total of perWalletPerDay.values()) {
          expect(total).toBeLessThanOrEqual(LIMITS.dailyCapLuna ?? 0n)
        }
        expect(pool).toBeLessThanOrEqual(LIMITS.poolTotalLuna ?? 0n)

        // A held claim is not money lost: every attempt is still on the record.
        expect(rows).toHaveLength(sequence.length)
      }),
      { numRuns: 200 },
    )
  }, 180_000)
})
