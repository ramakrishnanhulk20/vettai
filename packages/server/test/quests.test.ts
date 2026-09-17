// Covers the quest engine: what a day's set looks like, and how a kill, a parcel and a
// landmark move it along. It does NOT cover the socket that produces those events
// (rooms.test.ts and ws.test.ts do), and it does NOT cover claiming a finished quest,
// which is claims.api.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { dailyCapLuna } from '../src/config.js'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, quests, type Quest } from '../src/db/schema.js'
import { queueClaim } from '../src/domain/claims.js'
import { topByKills, weekOf } from '../src/domain/ladder.js'
import {
  applySimEvent,
  applyWorldEvents,
  courierDetail,
  HUNT_PROGRESS_CAP,
  questView,
  streakDay,
  todaysQuests,
  visitedLandmarks,
  type PlayerQuestEvent,
} from '../src/domain/quests.js'
import { streakReward } from '../src/domain/rewards.js'
import { utcDay } from '../src/lib/day.js'
import { generateMap } from '../src/world/map.js'
import { clearTables, freshDb, insertPlayer, randomHash } from './support/db.js'

const map = generateMap('vettai-test')
const DAY_ONE = new Date('2026-09-15T10:00:00Z')

let handle: DbHandle
let db: Db
let address: string

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  const player = await insertPlayer(db)
  address = player.address
})

function byKind(rows: Quest[], kind: string): Quest {
  const row = rows.find((quest) => quest.kind === kind)
  if (!row) throw new Error(`no ${kind} quest`)
  return row
}

/** The one row an event was expected to change, so a test never reads through undefined. */
function only(rows: Quest[]): Quest {
  const [row] = rows
  if (rows.length !== 1 || !row) throw new Error(`expected one changed quest, got ${rows.length}`)
  return row
}

async function reread(id: string): Promise<Quest> {
  const [row] = await db.select().from(quests).where(eq(quests.id, id)).limit(1)
  if (!row) throw new Error('the quest is gone')
  return row
}

/** Marks a day's streak quest as taken, which is what keeps a run alive. */
async function claimStreak(day: string): Promise<void> {
  await db
    .update(quests)
    .set({ state: 'claimed' })
    .where(and(eq(quests.address, address), eq(quests.day, day), eq(quests.kind, 'streak')))
}

function dayBefore(days: number): string {
  return new Date(DAY_ONE.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** A run of earlier days this wallet took its streak on, so today sits further up the curve. */
async function streakRun(days: number): Promise<void> {
  for (let back = days; back >= 1; back -= 1) {
    await db.insert(quests).values({
      address,
      day: dayBefore(back),
      kind: 'streak',
      target: 1,
      progress: 1,
      state: 'claimed',
      rewardLuna: 20_000n,
    })
  }
}

/** Money this wallet has already been granted on a day, which is what the clamp reads. */
async function grantedToday(amountLuna: bigint, when: Date = DAY_ONE): Promise<void> {
  await db.insert(claims).values({
    address,
    questId: null,
    kind: 'hunt',
    amountLuna,
    state: 'queued',
    memo: `vettai:${randomHash().slice(0, 8)}`,
    createdAt: when,
  })
}

/** Today's courier points for this wallet, read back out of the quest's own notes. */
async function courierRun(): Promise<{ from: number; to: number; id: string }> {
  const courier = byKind(await todaysQuests(db, address, map, DAY_ONE), 'courier')
  const detail = courierDetail(courier)
  if (!detail) throw new Error('the courier quest has no route')
  return { from: detail.from, to: detail.to, id: courier.id }
}

describe('todaysQuests', () => {
  it('creates the day set once and hands back the same rows after that', async () => {
    const first = await todaysQuests(db, address, map, DAY_ONE)
    const second = await todaysQuests(db, address, map, DAY_ONE)

    expect(first.map((quest) => quest.kind).sort()).toEqual(['courier', 'hunt', 'landmarks', 'streak'])
    expect(second.map((quest) => quest.id)).toEqual(first.map((quest) => quest.id))
    expect(await db.select().from(quests)).toHaveLength(4)
  })

  it('files the set under the UTC day, not the local one', async () => {
    const lateAtNight = new Date('2026-09-15T23:59:00Z')
    const rows = await todaysQuests(db, address, map, lateAtNight)

    expect(rows.every((quest) => quest.day === '2026-09-15')).toBe(true)
    expect(utcDay(lateAtNight)).toBe('2026-09-15')
  })

  it('hands the streak quest over already done, worth the first day of the curve', async () => {
    const streak = byKind(await todaysQuests(db, address, map, DAY_ONE), 'streak')

    expect(streak.state).toBe('done')
    expect(streak.progress).toBe(1)
    expect(streak.rewardLuna).toBe(20_000n)
    expect(streak.doneAt).not.toBeNull()
  })

  it('keeps the courier route in the detail column and the plain count in target', async () => {
    const courier = byKind(await todaysQuests(db, address, map, DAY_ONE), 'courier')
    const detail = courierDetail(courier)
    if (!detail) throw new Error('the courier quest has no route')

    expect(courier.target).toBe(1)
    expect(courier.progress).toBe(0)
    expect(detail.pickedUpAt).toBeNull()
    expect(detail.from).not.toBe(detail.to)
    expect(map.courier[detail.from]).toBeDefined()
    expect(map.courier[detail.to]).toBeDefined()
    expect(questView(courier)).toMatchObject({
      target: 1,
      progress: 0,
      route: { from: detail.from, to: detail.to },
      carrying: false,
    })
  })

  it('starts the landmarks quest with an empty visited list and a target of four', async () => {
    const landmarks = byKind(await todaysQuests(db, address, map, DAY_ONE), 'landmarks')

    expect(landmarks.target).toBe(4)
    expect(landmarks.progress).toBe(0)
    expect(landmarks.detail).toEqual({ visited: [] })
  })

  it('pays the landmarks tour in full on the first day and less on a later one', async () => {
    const first = byKind(await todaysQuests(db, address, map, DAY_ONE), 'landmarks')
    const later = byKind(
      await todaysQuests(db, address, map, new Date('2026-09-16T10:00:00Z')),
      'landmarks',
    )

    expect(first.rewardLuna).toBe(20_000n)
    expect(later.rewardLuna).toBe(5_000n)
  })

  it('leaves the landlord quest out while the key is off', async () => {
    const rows = await todaysQuests(db, address, map, DAY_ONE)

    expect(rows.some((quest) => quest.kind === 'landlord')).toBe(false)
  })

  it('creates the landlord quest when the key is on', async () => {
    vi.resetModules()
    vi.stubEnv('LANDLORD_ENABLED', 'true')
    try {
      const fresh = await import('../src/domain/quests.js')
      const rows = await fresh.todaysQuests(db, address, map, DAY_ONE)

      const landlord = byKind(rows, 'landlord')
      expect(landlord.state).toBe('open')
      expect(landlord.target).toBe(1)
      expect(landlord.rewardLuna).toBe(20_000n)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

describe('the hunt quest', () => {
  it('counts kills and finishes on the fifth', async () => {
    await todaysQuests(db, address, map, DAY_ONE)

    for (let kill = 1; kill <= 4; kill += 1) {
      const [row] = await applySimEvent(db, address, { kind: 'kill' }, DAY_ONE)
      expect(row?.progress).toBe(kill)
      expect(row?.state).toBe('open')
    }

    const [fifth] = await applySimEvent(db, address, { kind: 'kill' }, DAY_ONE)
    expect(fifth?.progress).toBe(5)
    expect(fifth?.state).toBe('done')
    expect(fifth?.doneAt).not.toBeNull()
  })

  it('keeps counting kills after the quest is done, so the ladder sees real play', async () => {
    const hunt = byKind(await todaysQuests(db, address, map, DAY_ONE), 'hunt')
    await db.update(quests).set({ progress: 20, state: 'claimed' }).where(eq(quests.id, hunt.id))

    const [row] = await applySimEvent(db, address, { kind: 'kill' }, DAY_ONE)

    expect(row?.progress).toBe(21)
    expect(row?.state).toBe('claimed')
  })

  it('stops counting at the cap rather than growing without a bound', async () => {
    const hunt = byKind(await todaysQuests(db, address, map, DAY_ONE), 'hunt')
    await db.update(quests).set({ progress: HUNT_PROGRESS_CAP }).where(eq(quests.id, hunt.id))

    expect(await applySimEvent(db, address, { kind: 'kill' }, DAY_ONE)).toEqual([])
    expect((await reread(hunt.id)).progress).toBe(HUNT_PROGRESS_CAP)
  })

  it('does nothing for a wallet with no quests today', async () => {
    expect(await applySimEvent(db, address, { kind: 'kill' }, DAY_ONE)).toEqual([])
  })
})

describe('the courier quest', () => {
  it('writes the pickup clock into the detail and finishes at the drop point', async () => {
    const { from, to, id } = await courierRun()
    const pickedUpAt = Math.floor(DAY_ONE.getTime() / 1000)

    expect(await applySimEvent(db, address, { kind: 'pickup', point: to }, DAY_ONE)).toEqual([])
    expect(await applySimEvent(db, address, { kind: 'deliver', point: to }, DAY_ONE)).toEqual([])

    const carrying = only(await applySimEvent(db, address, { kind: 'pickup', point: from }, DAY_ONE))
    expect(courierDetail(carrying)).toEqual({ from, to, pickedUpAt })
    expect(carrying.progress).toBe(0)
    expect(questView(carrying).carrying).toBe(true)

    const late = new Date(DAY_ONE.getTime() + 60_000)
    expect(await applySimEvent(db, address, { kind: 'deliver', point: from }, late)).toEqual([])

    const delivered = only(await applySimEvent(db, address, { kind: 'deliver', point: to }, late))
    expect(delivered.state).toBe('done')
    expect(delivered.id).toBe(id)
    expect(courierDetail(delivered)).toEqual({ from, to, pickedUpAt })
    expect(questView(delivered)).toMatchObject({ progress: 1, target: 1, carrying: false })
  })

  it('clears the pickup clock when the delivery is more than two minutes late', async () => {
    const { from, to } = await courierRun()
    await applySimEvent(db, address, { kind: 'pickup', point: from }, DAY_ONE)

    const tooLate = new Date(DAY_ONE.getTime() + 121_000)
    const [reset] = await applySimEvent(db, address, { kind: 'deliver', point: to }, tooLate)

    expect(reset?.state).toBe('open')
    expect(reset?.progress).toBe(0)
    expect(reset && courierDetail(reset)).toEqual({ from, to, pickedUpAt: null })
    expect(reset && questView(reset).carrying).toBe(false)

    const [again] = await applySimEvent(db, address, { kind: 'pickup', point: from }, tooLate)
    const [done] = await applySimEvent(db, address, { kind: 'deliver', point: to }, tooLate)
    expect(again && courierDetail(again)?.pickedUpAt).toBe(Math.floor(tooLate.getTime() / 1000))
    expect(done?.state).toBe('done')
  })

  it('leaves a finished courier quest alone', async () => {
    const { from, to } = await courierRun()
    await applySimEvent(db, address, { kind: 'pickup', point: from }, DAY_ONE)
    await applySimEvent(db, address, { kind: 'deliver', point: to }, DAY_ONE)

    expect(await applySimEvent(db, address, { kind: 'pickup', point: from }, DAY_ONE)).toEqual([])
  })
})

describe('the landmarks quest', () => {
  it('counts the same landmark once and finishes on the fourth', async () => {
    await todaysQuests(db, address, map, DAY_ONE)

    const one = only(await applySimEvent(db, address, { kind: 'landmark', index: 2 }, DAY_ONE))
    expect(one.detail).toEqual({ visited: [2] })
    expect(one.progress).toBe(1)
    expect(questView(one).visited).toEqual([false, false, true, false])

    expect(await applySimEvent(db, address, { kind: 'landmark', index: 2 }, DAY_ONE)).toEqual([])
    expect((await reread(one.id)).progress).toBe(1)

    await applySimEvent(db, address, { kind: 'landmark', index: 0 }, DAY_ONE)
    await applySimEvent(db, address, { kind: 'landmark', index: 1 }, DAY_ONE)
    const last = only(await applySimEvent(db, address, { kind: 'landmark', index: 3 }, DAY_ONE))

    expect(last.state).toBe('done')
    expect(visitedLandmarks(last)).toEqual([2, 0, 1, 3])
    expect(questView(last)).toMatchObject({ progress: 4, target: 4, visited: [true, true, true, true] })
  })

  it('refuses a landmark number the map does not have', async () => {
    await todaysQuests(db, address, map, DAY_ONE)

    expect(await applySimEvent(db, address, { kind: 'landmark', index: 4 }, DAY_ONE)).toEqual([])
    expect(await applySimEvent(db, address, { kind: 'landmark', index: -1 }, DAY_ONE)).toEqual([])
  })
})

describe('the streak', () => {
  it('counts the run of claimed days and pays further up the curve each day', async () => {
    const days = ['2026-09-15', '2026-09-16', '2026-09-17']
    const rewardsSeen: bigint[] = []

    for (const day of days) {
      const rows = await todaysQuests(db, address, map, new Date(`${day}T08:00:00Z`))
      rewardsSeen.push(byKind(rows, 'streak').rewardLuna)
      await claimStreak(day)
    }

    expect(rewardsSeen).toEqual([20_000n, 70_000n, 120_000n])
    expect(await streakDay(db, address, '2026-09-18')).toBe(4)
  })

  it('starts again at day one when a day is missed', async () => {
    await todaysQuests(db, address, map, new Date('2026-09-15T08:00:00Z'))
    await claimStreak('2026-09-15')

    const afterAGap = byKind(
      await todaysQuests(db, address, map, new Date('2026-09-17T08:00:00Z')),
      'streak',
    )

    expect(afterAGap.rewardLuna).toBe(20_000n)
  })

  it('counts a day the player turned up for even if they never claimed it', async () => {
    await todaysQuests(db, address, map, new Date('2026-09-15T08:00:00Z'))

    expect(await streakDay(db, address, '2026-09-16')).toBe(2)
  })

  it('keeps the run going through a day the cap left worth nothing', async () => {
    const dayTwo = new Date('2026-09-16T08:00:00Z')
    await todaysQuests(db, address, map, new Date('2026-09-15T08:00:00Z'))
    await claimStreak('2026-09-15')

    // This wallet has already had its whole day when day two is built, so day two's streak
    // is written at nothing and there is no claim to make on it.
    await grantedToday(dailyCapLuna, dayTwo)
    expect(byKind(await todaysQuests(db, address, map, dayTwo), 'streak').rewardLuna).toBe(0n)

    const dayThree = byKind(
      await todaysQuests(db, address, map, new Date('2026-09-17T08:00:00Z')),
      'streak',
    )

    expect(await streakDay(db, address, '2026-09-17')).toBe(3)
    expect(dayThree.rewardLuna).toBe(streakReward(3))
  })

  it('pays only what the daily cap still allows on a long run', async () => {
    await streakRun(10)
    await grantedToday(50_000n)

    const streak = byKind(await todaysQuests(db, address, map, DAY_ONE), 'streak')

    expect(dailyCapLuna).toBe(500_000n)
    expect(streakReward(11)).toBe(520_000n)
    expect(streak.rewardLuna).toBe(450_000n)
    expect(streak.detail).toEqual({ clamped: true })
  })

  it('leaves the full curve alone when the day has room for it', async () => {
    await streakRun(2)

    const streak = byKind(await todaysQuests(db, address, map, DAY_ONE), 'streak')

    expect(streak.rewardLuna).toBe(streakReward(3))
    expect(streak.detail).toBeNull()
  })

  it('writes a streak worth nothing for a wallet that has had its whole day', async () => {
    await grantedToday(dailyCapLuna)

    const streak = byKind(await todaysQuests(db, address, map, DAY_ONE), 'streak')

    expect(streak.rewardLuna).toBe(0n)
    expect(streak.state).toBe('done')
    expect(streak.detail).toEqual({ clamped: true })

    // The payout path is what refuses it, which is how the route answers "nothing to claim".
    await expect(
      queueClaim(db, {
        address,
        questId: streak.id,
        kind: 'streak',
        amountLuna: streak.rewardLuna,
        now: DAY_ONE,
      }),
    ).rejects.toThrow(/worth more than nothing/)
  })
})

describe('the weekly ladder', () => {
  it('still counts kills off the hunt quest progress', async () => {
    await todaysQuests(db, address, map, DAY_ONE)
    for (let kill = 0; kill < 3; kill += 1) {
      await applySimEvent(db, address, { kind: 'kill' }, DAY_ONE)
    }

    expect(await topByKills(db, weekOf(DAY_ONE), 3)).toEqual([{ address, kills: 3 }])
  })
})

describe('applyWorldEvents', () => {
  it('groups a tick of events by the player they belong to', async () => {
    const other = await insertPlayer(db)
    await todaysQuests(db, address, map, DAY_ONE)
    await todaysQuests(db, other.address, map, DAY_ONE)

    const changed = await applyWorldEvents(
      db,
      [
        { address, kind: 'kill' },
        { address, kind: 'kill' },
        { address: other.address, kind: 'landmark', index: 1 },
        { address: other.address, kind: 'kill' },
      ],
      DAY_ONE,
    )

    expect(changed).toHaveLength(2)
    const mine = changed.find((row) => row.address === address)
    expect(mine?.quests).toHaveLength(2)
    expect(mine?.quests.at(-1)?.progress).toBe(2)
    expect(changed.find((row) => row.address === other.address)?.quests).toHaveLength(2)
  })

  it('finishes a courier run when the pickup and the delivery are in the same batch', async () => {
    const { from, to } = await courierRun()

    const changed = await applyWorldEvents(
      db,
      [
        { address, kind: 'pickup', point: from },
        { address, kind: 'deliver', point: to },
      ],
      DAY_ONE,
    )

    expect(changed).toHaveLength(1)
    expect(changed[0]?.quests.at(-1)?.state).toBe('done')
  })

  it('does not finish a courier run when the delivery comes first in the batch', async () => {
    const { from, to } = await courierRun()

    const changed = await applyWorldEvents(
      db,
      [
        { address, kind: 'deliver', point: to },
        { address, kind: 'pickup', point: from },
      ],
      DAY_ONE,
    )

    expect(changed[0]?.quests).toHaveLength(1)
    const courier = byKind(await todaysQuests(db, address, map, DAY_ONE), 'courier')
    expect(courier.state).toBe('open')
    expect(courierDetail(courier)?.pickedUpAt).not.toBeNull()
  })

  it('writes none of the batch when one event in it fails', async () => {
    await todaysQuests(db, address, map, DAY_ONE)
    // The broken event stands in for a database failure part way through a tick.
    const batch: PlayerQuestEvent[] = [
      { address, kind: 'kill' },
      undefined as unknown as PlayerQuestEvent,
    ]

    await expect(applyWorldEvents(db, batch, DAY_ONE)).rejects.toThrow()

    const hunt = byKind(await todaysQuests(db, address, map, DAY_ONE), 'hunt')
    expect(hunt.progress).toBe(0)
  })
})
