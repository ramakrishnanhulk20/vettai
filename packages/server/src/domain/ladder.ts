import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { claims, ladderPeriods, quests } from '../db/schema.js'
import { DAY_MS } from '../lib/day.js'
import { queueClaimIn, type Tx } from './claims.js'
import { rewards } from './rewards.js'

/** Reads on either the database or an open transaction, because payLadder needs both. */
type Reader = Db | Tx

const PERIOD = /^(\d{4})-W(\d{2})$/

function mondayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7
}

/**
 * The week a moment belongs to, written the ISO way: 2026-W41 is the week that starts on
 * Monday. The year in front is the ISO week year, not the calendar year, so the 1st of
 * January can belong to the last week of the year before, which is exactly what the
 * ladder has to get right when it pays on the first Monday of a new year.
 */
export function weekOf(date: Date): string {
  const thursday = new Date(date.getTime())
  thursday.setUTCHours(0, 0, 0, 0)
  thursday.setUTCDate(thursday.getUTCDate() - mondayIndex(thursday) + 3)

  const weekYear = thursday.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4))
  firstThursday.setUTCDate(firstThursday.getUTCDate() - mondayIndex(firstThursday) + 3)

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS))
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

export type WeekRange = {
  start: Date
  end: Date
  /** The seven UTC dates the quests of this week are filed under, as YYYY-MM-DD. */
  days: string[]
}

/** Monday 00:00:00 UTC up to, but not including, the next Monday. */
export function weekRange(week: string): WeekRange {
  const match = PERIOD.exec(week)
  if (!match?.[1] || !match[2]) throw new Error(`"${week}" is not a week like 2026-W41`)

  const weekYear = Number(match[1])
  const number = Number(match[2])

  const firstMonday = new Date(Date.UTC(weekYear, 0, 4))
  firstMonday.setUTCDate(firstMonday.getUTCDate() - mondayIndex(firstMonday))

  const start = new Date(firstMonday.getTime() + (number - 1) * 7 * DAY_MS)
  const end = new Date(start.getTime() + 7 * DAY_MS)

  const days: string[] = []
  for (let day = 0; day < 7; day += 1) {
    days.push(new Date(start.getTime() + day * DAY_MS).toISOString().slice(0, 10))
  }

  return { start, end, days }
}

/** The week that has just closed, which is the one a Monday morning pays. */
export function previousWeek(now: Date): string {
  return weekOf(new Date(now.getTime() - 7 * DAY_MS))
}

export type LadderEntry = { address: string; kills: number }

/**
 * Who killed the most drones this week. The count comes off the hunt quest rows, which
 * the world keeps counting past the quest's target, so the ladder sees real play and not
 * just "finished the quest".
 */
export async function topByKills(db: Reader, week: string, limit: number): Promise<LadderEntry[]> {
  const { days } = weekRange(week)

  const rows = await (db as Db)
    .select({ address: quests.address, kills: sql<string>`sum(${quests.progress})` })
    .from(quests)
    .where(and(eq(quests.kind, 'hunt'), inArray(quests.day, days)))
    .groupBy(quests.address)
    .having(sql`sum(${quests.progress}) > 0`)
    .orderBy(sql`sum(${quests.progress}) desc`, quests.address)
    .limit(limit)

  return rows.map((row) => ({ address: row.address, kills: Number(row.kills) }))
}

export type LadderResult = {
  week: string
  paid: boolean
  winners: LadderEntry[]
  claimIds: string[]
}

/**
 * Pays the top three of one week, once and only once.
 *
 * The period row goes in first, inside the transaction, so a second caller that arrives
 * while this one is still queueing claims is refused by the primary key rather than by a
 * check it could have raced past. That race is exactly how a prize gets paid twice: the
 * game this copies had a public endpoint with no lock and multiplied a period's payout.
 * A week with nobody in it still writes its row, so it is never looked at again.
 */
export async function payLadder(db: Db, week: string, now: Date = new Date()): Promise<LadderResult> {
  weekRange(week)

  return db.transaction(async (tx) => {
    // The pool lock comes first and is held for the whole transaction, before any wallet
    // lock queueClaimIn takes below. A week pays up to three wallets in one transaction,
    // so taking the wallets first is a cycle waiting to happen: this run holding wallet
    // one and wanting the pool, while a player's own claim holds the pool and wants
    // wallet one. Postgres would break that by killing one of them.
    await tx.execute(sql`select pg_advisory_xact_lock(0)`)

    const [period] = await tx
      .insert(ladderPeriods)
      .values({ period: week, paidAt: now, claimIds: [] })
      .onConflictDoNothing({ target: ladderPeriods.period })
      .returning({ period: ladderPeriods.period })

    if (!period) return { week, paid: false, winners: [], claimIds: [] }

    const winners = await topByKills(tx, week, rewards.ladder.length)
    const claimIds: string[] = []

    for (const [place, winner] of winners.entries()) {
      const prize = rewards.ladder[place]
      if (prize === undefined || prize <= 0n) continue

      const result = await queueClaimIn(tx, {
        address: winner.address,
        questId: null,
        kind: 'ladder',
        amountLuna: prize,
        memo: `vettai:ladder:${week}`,
        now,
      })

      claimIds.push(result.claimId)
    }

    await tx.update(ladderPeriods).set({ claimIds }).where(eq(ladderPeriods.period, week))

    return { week, paid: true, winners, claimIds }
  })
}

/**
 * How many closed weeks one catch-up pass will walk. A floor that is years old, or a clock
 * that jumped, must not turn one pass into thousands of transactions.
 */
export const MAX_CATCHUP_WEEKS = 104

/** Every ISO week from one to another, both ends included, oldest first. */
export function weeksFrom(first: string, last: string): string[] {
  const start = weekRange(first).start
  const end = weekRange(last).start

  const weeks: string[] = []
  for (let at = start; at.getTime() <= end.getTime(); at = new Date(at.getTime() + 7 * DAY_MS)) {
    weeks.push(weekOf(at))
    if (weeks.length >= MAX_CATCHUP_WEEKS) break
  }

  return weeks
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The week the oldest play or the oldest claim happened in, which is as far back as a
 * ladder can owe anything.
 *
 * The kills are what the ladder pays on, so they are what the floor is read from. A first
 * week where everybody hunted and nobody claimed leaves the claims table empty, and a floor
 * read off claims alone would land on this week and never pay that one.
 */
export async function firstPlayedWeek(db: Db, now: Date): Promise<string> {
  const [claimed] = await db
    .select({ oldest: sql<string | null>`min(${claims.createdAt})` })
    .from(claims)

  // The oldest day is read as the column itself rather than as min(), so the driver hands
  // back the YYYY-MM-DD the rest of the server files quests under and not a local midnight.
  const [played] = await db
    .select({ oldest: quests.day })
    .from(quests)
    .where(and(eq(quests.kind, 'hunt'), gt(quests.progress, 0)))
    .orderBy(quests.day)
    .limit(1)

  const oldest = [asDate(claimed?.oldest), asDate(played ? `${played.oldest}T00:00:00Z` : null)]
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0]

  return oldest ? weekOf(oldest) : weekOf(now)
}

export type LadderCatchUp = {
  /** The weeks this pass paid, oldest first. Empty when nothing was owed. */
  paid: string[]
  /** Where the walk started, so a log line can say it. */
  from: string
}

/**
 * Pays every closed week that has no period row yet, oldest first.
 *
 * There is no Monday gate. A treasury that was asleep on Monday, or was deployed on a
 * Wednesday, used to skip that week's prizes for good; now any pass picks up whatever is
 * owed. payLadder is what makes this safe to call as often as we like: the period row is the
 * primary key, so a week already paid costs one refused insert and nothing else.
 */
export async function payDueLadders(
  db: Db,
  now: Date = new Date(),
  floorWeek?: string,
): Promise<LadderCatchUp> {
  const closed = previousWeek(now)
  const from = floorWeek ?? (await firstPlayedWeek(db, now))

  if (weekRange(from).start.getTime() > weekRange(closed).start.getTime()) return { paid: [], from }

  const wanted = weeksFrom(from, closed)
  const done = new Set(
    (await db.select({ period: ladderPeriods.period }).from(ladderPeriods)).map((row) => row.period),
  )

  const paid: string[] = []
  for (const week of wanted) {
    if (done.has(week)) continue
    const result = await payLadder(db, week, now)
    if (result.paid) paid.push(week)
  }

  return { paid, from }
}
