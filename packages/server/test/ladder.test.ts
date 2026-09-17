// Covers the weekly ladder: which week a moment belongs to, who is top, paying a closed
// week once, and the order the locks are taken in. It does NOT cover the timer in the
// treasury that decides when to call payLadder, it does NOT send the prizes (that is the
// outbox), and it does NOT prove the locks against a real Postgres with two connections:
// PGlite runs one statement at a time, so the order of the statements is what is proven.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import type { Tx } from '../src/domain/claims.js'
import { claims, ladderPeriods, quests } from '../src/db/schema.js'
import {
  firstPlayedWeek,
  payDueLadders,
  payLadder,
  previousWeek,
  topByKills,
  weekOf,
  weekRange,
} from '../src/domain/ladder.js'
import { rewards } from '../src/domain/rewards.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'

const WEEK = '2026-W38'
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

async function playerWithKills(kills: { day: string; count: number }[]): Promise<string> {
  const { address } = await insertPlayer(db)

  for (const kill of kills) {
    await db.insert(quests).values({
      address,
      day: kill.day,
      kind: 'hunt',
      target: 5,
      progress: kill.count,
      state: kill.count >= 5 ? 'done' : 'open',
      rewardLuna: nimToLuna('0.5'),
    })
  }

  return address
}

describe('weekOf and weekRange', () => {
  it('names the ISO week, including the one that crosses the new year', () => {
    expect(weekOf(new Date('2026-09-15T10:00:00Z'))).toBe('2026-W38')
    expect(weekOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01')
    expect(weekOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026-W53')
    expect(weekOf(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53')
    expect(weekOf(new Date('2027-01-04T00:00:00Z'))).toBe('2027-W01')
    expect(weekOf(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01')
  })

  it('runs from Monday midnight to the next Monday midnight, UTC', () => {
    const range = weekRange(WEEK)

    expect(range.start.toISOString()).toBe('2026-09-14T00:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-09-21T00:00:00.000Z')
    expect(range.days).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ])
    expect(weekOf(range.start)).toBe(WEEK)
    expect(previousWeek(MONDAY)).toBe(WEEK)
    expect(() => weekRange('nonsense')).toThrow(/2026-W41/)
  })
})

describe('topByKills', () => {
  it('adds up the kills of the week and leaves the other weeks alone', async () => {
    const best = await playerWithKills([
      { day: '2026-09-14', count: 7 },
      { day: '2026-09-16', count: 9 },
    ])
    const second = await playerWithKills([{ day: '2026-09-15', count: 12 }])
    const lastWeek = await playerWithKills([{ day: '2026-09-07', count: 40 }])
    await playerWithKills([{ day: '2026-09-15', count: 0 }])

    const top = await topByKills(db, WEEK, 3)

    expect(top).toEqual([
      { address: best, kills: 16 },
      { address: second, kills: 12 },
    ])
    expect(top.map((entry) => entry.address)).not.toContain(lastWeek)
  })
})

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

/** The database, with every statement the ladder's transaction runs written down in order. */
function recordingDb(real: Db, statements: string[]): Db {
  const recordTx = (tx: Tx): Tx =>
    new Proxy(tx as object, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value

        return (...args: unknown[]) => {
          if (property === 'execute') statements.push(textOf(args[0]))
          return (value as (...rest: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as Tx

  return new Proxy(real as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value

      if (property === 'transaction') {
        return (callback: (tx: Tx) => unknown, ...rest: unknown[]) =>
          (value as (...args: unknown[]) => unknown).call(target, (tx: Tx) => callback(recordTx(tx)), ...rest)
      }

      return (...args: unknown[]) => (value as (...rest: unknown[]) => unknown).apply(target, args)
    },
  }) as Db
}

describe('payLadder', () => {
  it('takes the pool lock before any wallet lock', async () => {
    await playerWithKills([{ day: '2026-09-15', count: 30 }])
    await playerWithKills([{ day: '2026-09-15', count: 20 }])

    const statements: string[] = []
    const result = await payLadder(recordingDb(db, statements), WEEK, MONDAY)
    expect(result.claimIds).toHaveLength(2)

    const locks = statements.filter((statement) => statement.includes('pg_advisory_xact_lock'))
    const pool = locks.findIndex((statement) => statement.includes('pg_advisory_xact_lock(0)'))
    const firstWallet = locks.findIndex((statement) => statement.includes('hashtext('))

    expect(pool).toBe(0)
    expect(firstWallet).toBeGreaterThan(pool)
  })

  it('queues the three prizes once and refuses to pay the same week twice', async () => {
    const first = await playerWithKills([{ day: '2026-09-15', count: 30 }])
    const second = await playerWithKills([{ day: '2026-09-15', count: 20 }])
    const third = await playerWithKills([{ day: '2026-09-15', count: 10 }])
    await playerWithKills([{ day: '2026-09-15', count: 1 }])

    const result = await payLadder(db, WEEK, MONDAY)

    expect(result.paid).toBe(true)
    expect(result.winners.map((entry) => entry.address)).toEqual([first, second, third])
    expect(result.claimIds).toHaveLength(3)

    const rows = await db.select().from(claims).where(eq(claims.kind, 'ladder'))
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.memo === `vettai:ladder:${WEEK}`)).toBe(true)
    expect(rows.every((row) => row.questId === null)).toBe(true)
    expect(rows.map((row) => row.amountLuna).sort((a, b) => Number(b - a))).toEqual(
      [...rewards.ladder].sort((a, b) => Number(b - a)),
    )

    const [period] = await db.select().from(ladderPeriods).where(eq(ladderPeriods.period, WEEK))
    expect(period?.claimIds).toHaveLength(3)

    const again = await payLadder(db, WEEK, new Date(MONDAY.getTime() + 60_000))
    expect(again.paid).toBe(false)
    expect(again.claimIds).toHaveLength(0)
    expect(await db.select().from(claims).where(eq(claims.kind, 'ladder'))).toHaveLength(3)
  })

  it('closes a week nobody played, so it is never looked at again', async () => {
    const result = await payLadder(db, WEEK, MONDAY)

    expect(result).toMatchObject({ paid: true, winners: [], claimIds: [] })
    expect(await db.select().from(ladderPeriods)).toHaveLength(1)
    expect(await db.select().from(claims)).toHaveLength(0)
  })
})

describe('payDueLadders', () => {
  it('pays every closed week the treasury slept through, not just this Monday', async () => {
    // Two weeks of play, and a treasury that was down over both Mondays. The catch-up pass
    // runs on a Wednesday, which the old Monday gate would have walked straight past.
    await playerWithKills([
      { day: '2026-09-15', count: 12 },
      { day: '2026-09-22', count: 9 },
    ])

    const wednesday = new Date('2026-09-30T11:00:00Z')
    const caught = await payDueLadders(db, wednesday, '2026-W38')

    expect(caught.paid).toEqual(['2026-W38', '2026-W39'])

    const periods = await db.select().from(ladderPeriods)
    expect(periods.map((row) => row.period).sort()).toEqual(['2026-W38', '2026-W39'])
    expect(await db.select().from(claims).where(eq(claims.kind, 'ladder'))).toHaveLength(2)

    // The week that is still running is not paid, and a second pass pays nothing again.
    const again = await payDueLadders(db, wednesday, '2026-W38')
    expect(again.paid).toEqual([])
    expect(await db.select().from(claims).where(eq(claims.kind, 'ladder'))).toHaveLength(2)
  })

  it('starts at the week of the oldest claim when no floor is set', async () => {
    const address = await playerWithKills([{ day: '2026-09-15', count: 6 }])

    await db.insert(claims).values({
      address,
      questId: null,
      kind: 'ladder',
      amountLuna: nimToLuna('0.1'),
      memo: 'vettai:test:first',
      createdAt: new Date('2026-09-16T08:00:00Z'),
    })

    expect(await firstPlayedWeek(db, MONDAY)).toBe('2026-W38')

    const caught = await payDueLadders(db, new Date('2026-09-23T04:00:00Z'))
    expect(caught.from).toBe('2026-W38')
    expect(caught.paid).toEqual(['2026-W38'])
  })
})
