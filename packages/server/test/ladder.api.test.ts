// Covers the public weekly ladder read. It does NOT pay the prizes: payLadder and the
// week maths are proven in ladder.test.ts.

import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { quests } from '../src/db/schema.js'
import { weekOf } from '../src/domain/ladder.js'
import { rewards } from '../src/domain/rewards.js'
import { utcDay } from '../src/lib/day.js'
import { shortAddress } from '../src/routes/ladder.js'
import { testApp } from './support/api.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'

const today = utcDay(new Date())

let handle: DbHandle
let db: Db
let app: FastifyInstance

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  app = await testApp(db)
})

afterEach(async () => {
  await app.close()
})

/** A wallet with a day's kills on the board, which is what the ladder counts. */
async function playerWithKills(kills: number): Promise<string> {
  const player = await insertPlayer(db)
  await db.insert(quests).values({
    address: player.address,
    day: today,
    kind: 'hunt',
    target: 5,
    progress: kills,
    rewardLuna: rewards.hunt,
  })
  return player.address
}

describe('GET /api/ladder/week', () => {
  it('answers with this week and nobody in it before anyone plays', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ladder/week' })

    const body = response.json<{ week: string; entries: unknown[]; prizesNim: string[] }>()
    expect(response.statusCode).toBe(200)
    expect(body.week).toBe(weekOf(new Date()))
    expect(body.entries).toEqual([])
    expect(body.prizesNim).toEqual(['2', '1', '0.5'])
  })

  it('ranks by kills and shortens the addresses', async () => {
    const quiet = await playerWithKills(3)
    const busy = await playerWithKills(31)
    const middling = await playerWithKills(12)

    const response = await app.inject({ method: 'GET', url: '/api/ladder/week' })

    const body = response.json<{ entries: { place: number; address: string; kills: number }[] }>()
    expect(body.entries.map((entry) => entry.kills)).toEqual([31, 12, 3])
    expect(body.entries.map((entry) => entry.place)).toEqual([1, 2, 3])
    expect(body.entries[0]?.address).toBe(shortAddress(busy))
    expect(body.entries[2]?.address).toBe(shortAddress(quiet))
    expect(body.entries.map((entry) => entry.address)).not.toContain(middling)
  })

  it('stops at ten and needs no session', async () => {
    for (let n = 1; n <= 12; n += 1) await playerWithKills(n)

    const response = await app.inject({ method: 'GET', url: '/api/ladder/week' })

    const body = response.json<{ entries: { kills: number }[] }>()
    expect(body.entries).toHaveLength(10)
    expect(body.entries[0]?.kills).toBe(12)
    expect(body.entries[9]?.kills).toBe(3)
  })
})
