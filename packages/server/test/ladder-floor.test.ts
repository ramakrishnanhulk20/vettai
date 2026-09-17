// Covers where the weekly catch-up starts walking from: the oldest week anybody actually
// played, not just the oldest week anybody claimed. It does NOT cover paying a week or the
// locks around it, which is ladder.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, quests } from '../src/db/schema.js'
import { firstPlayedWeek, payDueLadders } from '../src/domain/ladder.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'

const MONDAY = new Date('2026-09-21T00:05:00Z')

let handle: DbHandle
let db: Db

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
})

async function hunted(day: string, kills: number): Promise<string> {
  const { address } = await insertPlayer(db)

  await db.insert(quests).values({
    address,
    day,
    kind: 'hunt',
    target: 5,
    progress: kills,
    state: kills >= 5 ? 'done' : 'open',
    rewardLuna: nimToLuna('0.5'),
  })

  return address
}

describe('the week the catch-up starts from', () => {
  it('pays a week people played but never claimed', async () => {
    await hunted('2026-09-15', 12)

    expect(await db.select().from(claims)).toHaveLength(0)
    expect(await firstPlayedWeek(db, MONDAY)).toBe('2026-W38')

    const caught = await payDueLadders(db, new Date('2026-09-23T04:00:00Z'))

    expect(caught.from).toBe('2026-W38')
    expect(caught.paid).toEqual(['2026-W38'])
    expect(await db.select().from(claims).where(eq(claims.kind, 'ladder'))).toHaveLength(1)
  })

  it('ignores a day that was opened but never played', async () => {
    await hunted('2026-09-15', 0)
    await hunted('2026-09-22', 4)

    expect(await firstPlayedWeek(db, MONDAY)).toBe('2026-W39')
  })

  it('takes the older of the oldest claim and the oldest day played', async () => {
    const address = await hunted('2026-09-22', 6)

    await db.insert(claims).values({
      address,
      questId: null,
      kind: 'hunt',
      amountLuna: nimToLuna('0.5'),
      memo: 'vettai:floor:test',
      createdAt: new Date('2026-09-16T08:00:00Z'),
    })

    expect(await firstPlayedWeek(db, MONDAY)).toBe('2026-W38')
  })
})
