// Covers the two database locks a claim is measured under: the pool first, then the
// wallet, both taken inside the claim's own transaction before any total is read. It does
// NOT prove the locks on a real Postgres with several connections, which is the case they
// exist for: PGlite runs one statement at a time, so what is proven here is the shape,
// that the statements are issued and in that order, plus that a run of claims never
// overruns a cap. Parallel Postgres is proven by the lock statements, not by execution
// here. The amounts side of the caps is proven in claims.caps.property.test.ts.

import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims } from '../src/db/schema.js'
import { queueClaim, queueClaimIn, type Limits, type Tx } from '../src/domain/claims.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const LIMITS: Limits = { dailyCapLuna: 100_000n, poolTotalLuna: 1_000_000n, ipWalletsPerDay: 99 }

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

type Step = { call: string; text: string }

/** The literal text of a drizzle query, with the values left out. */
function textOf(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks
    .map((chunk) => {
      const parts = (chunk as { value?: unknown }).value
      return Array.isArray(parts) ? parts.join('') : ''
    })
    .join('')
}

/** The transaction the claim is handed, with every call it makes written down in order. */
function recording(tx: Tx, steps: Step[]): Tx {
  return new Proxy(tx as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value

      const name = String(property)
      return (...args: unknown[]) => {
        steps.push({ call: name, text: name === 'execute' ? textOf(args[0]) : '' })
        return (value as (...rest: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as Tx
}

describe('the locks a claim is measured under', () => {
  it('takes the pool lock and then the wallet lock before it reads any total', async () => {
    const steps: Step[] = []

    const result = await db.transaction((tx) =>
      queueClaimIn(recording(tx, steps), {
        address: player,
        questId: null,
        kind: 'ladder',
        amountLuna: 50_000n,
        memo: 'vettai:test:locks',
        now: NOW,
        limits: LIMITS,
      }),
    )

    expect(result.state).toBe('queued')

    const locks = steps.filter((step) => step.text.includes('pg_advisory_xact_lock'))
    expect(locks).toHaveLength(2)
    expect(locks[0]?.text).toContain('pg_advisory_xact_lock(0)')
    expect(locks[1]?.text).toContain('pg_advisory_xact_lock(hashtext(')

    expect(steps[0]).toBe(locks[0])
    expect(steps[1]).toBe(locks[1])

    const firstRead = steps.findIndex((step) => step.call === 'select')
    expect(firstRead).toBeGreaterThan(1)
  })

  it('never lets a wallet over its daily cap, whatever the amounts are', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 10_000, max: 60_000 }), { minLength: 2, maxLength: 8 }),
        async (amounts: number[]) => {
          await db.delete(claims)

          await Promise.all(
            amounts.map((amount, index) =>
              queueClaim(db, {
                address: player,
                questId: null,
                kind: 'ladder',
                amountLuna: BigInt(amount),
                memo: `vettai:test:${index}`,
                now: NOW,
                limits: LIMITS,
              }),
            ),
          )

          const rows = await db.select().from(claims)
          const committed = rows
            .filter((row) => row.state !== 'held')
            .reduce((total, row) => total + row.amountLuna, 0n)

          expect(committed).toBeLessThanOrEqual(LIMITS.dailyCapLuna ?? 0n)
          expect(rows).toHaveLength(amounts.length)
        },
      ),
      { numRuns: 40 },
    )
  }, 120_000)
})
