// Covers the public numbers the landing page reads, and the daily totals the world keeps.
// It does NOT cover how a claim reaches the paid state, which is the treasury's job and is
// proven in outbox.test.ts and sender.test.ts.

import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, quests, STARTING_GEAR } from '../src/db/schema.js'
import { bumpDaily, publicStats } from '../src/domain/stats.js'
import { utcDay } from '../src/lib/day.js'
import { worldMap } from '../src/routes/world.js'
import { createRooms, type Rooms } from '../src/world/rooms.js'
import { testApp } from './support/api.js'
import { clearTables, freshDb, insertPlayer, randomHash } from './support/db.js'

const map = worldMap()
const now = new Date()
const today = utcDay(now)

let handle: DbHandle
let db: Db
let app: FastifyInstance
let rooms: Rooms

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  rooms = createRooms({ map, seed: 'stats-test' })
  app = await testApp(db, { world: { map, rooms } })
})

afterEach(async () => {
  rooms.stop()
  await app.close()
})

async function playerWhoPlayed(kills: number, day: string = today): Promise<string> {
  const player = await insertPlayer(db)
  await db.insert(quests).values({
    address: player.address,
    day,
    kind: 'hunt',
    target: 5,
    progress: kills,
    rewardLuna: 50_000n,
  })
  return player.address
}

describe('publicStats', () => {
  it('counts today apart from all time', async () => {
    await playerWhoPlayed(4)
    await playerWhoPlayed(7)
    await playerWhoPlayed(9, '2026-01-01')
    await insertPlayer(db)

    const stats = await publicStats(db, now)

    expect(stats.day).toBe(today)
    expect(stats.playersToday).toBe(2)
    expect(stats.playersAllTime).toBe(4)
    expect(stats.killsToday).toBe(11)
  })

  it('counts only the money that has really been paid', async () => {
    const address = await playerWhoPlayed(1)
    await db.insert(claims).values([
      {
        address,
        questId: null,
        kind: 'ladder',
        amountLuna: 200_000n,
        state: 'paid',
        memo: 'vettai:ladder:one',
        txHash: randomHash(),
      },
      {
        address,
        questId: null,
        kind: 'ladder',
        amountLuna: 50_000n,
        state: 'queued',
        memo: 'vettai:ladder:two',
      },
    ])

    const stats = await publicStats(db, now)

    expect(stats.paidLuna).toBe(200_000n)
    expect(stats.paidNim).toBe('2')
    expect(stats.claimsPaid).toBe(1)
  })

  it('hands back the last seven days that have rows, oldest first', async () => {
    const days = ['09', '10', '11', '12', '13', '14', '15', '16', '17'].map((d) => `2026-08-${d}`)
    for (const [index, day] of days.entries()) await bumpDaily(db, day, { players: 1, kills: index })
    await bumpDaily(db, '2026-08-20', { kills: 99 })

    const stats = await publicStats(db, new Date('2026-08-17T12:00:00Z'))

    expect(stats.history.map((row) => row.day)).toEqual(days.slice(2))
    expect(stats.history.at(-1)).toEqual({ day: '2026-08-17', players: 1, kills: 8, paidLuna: '0' })
  })

  it('answers with zeros on an empty world', async () => {
    const stats = await publicStats(db, now)

    expect(stats).toMatchObject({
      playersToday: 0,
      playersAllTime: 0,
      killsToday: 0,
      paidLuna: 0n,
      claimsPaid: 0,
    })
  })
})

describe('bumpDaily', () => {
  it('creates the day and then adds to it', async () => {
    await bumpDaily(db, today, { players: 1, kills: 3 })
    await bumpDaily(db, today, { kills: 2, paidLuna: 50_000n })

    expect((await publicStats(db, now)).history).toEqual([
      { day: today, players: 1, kills: 5, paidLuna: '50000' },
    ])
  })

  it('writes nothing at all for an empty bump', async () => {
    await bumpDaily(db, today, {})

    expect((await publicStats(db, now)).history).toEqual([])
  })
})

describe('the public routes', () => {
  it('serves the stats with the money as a string, without a session', async () => {
    await playerWhoPlayed(6)

    const response = await app.inject({ method: 'GET', url: '/api/stats' })

    const body = response.json<{ killsToday: number; paidLuna: string; paidNim: string }>()
    expect(response.statusCode).toBe(200)
    expect(body.killsToday).toBe(6)
    expect(body.paidLuna).toBe('0')
    expect(body.paidNim).toBe('0')
  })

  it('reports the live room and player counts on /health', async () => {
    const before = await app.inject({ method: 'GET', url: '/health' })
    expect(before.json()).toMatchObject({ ok: true, rooms: 0, online: 0 })

    rooms.join('NQTEST', STARTING_GEAR, { send: () => {}, close: () => {} })

    const after = await app.inject({ method: 'GET', url: '/health' })
    expect(after.json()).toMatchObject({ ok: true, rooms: 1, online: 1 })
  })
})
