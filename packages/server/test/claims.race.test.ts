// Covers twenty claims for one quest arriving at the same moment, which is the case no
// read-then-write check can win on its own. It does NOT prove the same thing on a real
// Postgres with twenty connections: PGlite runs one statement at a time, so what is
// proven here is that the partial unique index, not the ordering, is what refuses the
// nineteen.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, quests } from '../src/db/schema.js'
import { queueClaim, type QueueClaimResult } from '../src/domain/claims.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'

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

describe('queueClaim under a race', () => {
  it('writes exactly one claim when twenty requests claim one quest together', async () => {
    const [quest] = await db
      .insert(quests)
      .values({
        address: player,
        day: '2026-09-15',
        kind: 'hunt',
        target: 5,
        state: 'done',
        rewardLuna: nimToLuna('0.5'),
      })
      .returning({ id: quests.id })

    const questId = quest?.id
    if (!questId) throw new Error('could not insert the test quest')

    const attempts: Promise<QueueClaimResult>[] = []
    for (let attempt = 0; attempt < 20; attempt += 1) {
      attempts.push(
        queueClaim(db, {
          address: player,
          questId,
          kind: 'hunt',
          amountLuna: nimToLuna('0.5'),
          ipHash: 'one-phone',
          now: NOW,
        }),
      )
    }

    const results = await Promise.all(attempts)

    const queued = results.filter((result) => result.state === 'queued')
    const refused = results.filter((result) => result.state === 'refused')

    expect(queued).toHaveLength(1)
    expect(refused).toHaveLength(19)
    expect(new Set(results.map((result) => result.claimId)).size).toBe(1)

    const rows = await db.select().from(claims).where(eq(claims.questId, questId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('queued')
    expect(rows[0]?.amountLuna).toBe(nimToLuna('0.5'))
  })
})
