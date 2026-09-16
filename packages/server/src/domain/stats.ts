import { desc, eq, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { players, quests, statsDaily } from '../db/schema.js'
import { utcDay } from '../lib/day.js'
import { lunaToNim } from '../lib/luna.js'
import { claimTotals } from './claims.js'

/**
 * The numbers the landing page is allowed to show. Every one of them is counted from rows
 * the server wrote itself: quests for play, claims for money. Nothing here is an estimate
 * and nothing here is typed in by hand.
 */

/** How many past days the landing page gets. A week reads as a week and the query stays small. */
const HISTORY_DAYS = 7

/** One finished day, with the money as a string because JSON has no bigint. */
export type DailyTotals = {
  day: string
  players: number
  kills: number
  paidLuna: string
}

export type PublicStats = {
  day: string
  playersToday: number
  playersAllTime: number
  killsToday: number
  paidLuna: bigint
  paidNim: string
  claimsPaid: number
  /** The last seven days that have rows, oldest first. Days nobody played are simply absent. */
  history: DailyTotals[]
}

function toNumber(value: unknown): number {
  return Number(value ?? 0)
}

export async function publicStats(db: Db, now: Date = new Date()): Promise<PublicStats> {
  const day = utcDay(now)

  const [today] = await db
    .select({
      players: sql<string>`count(distinct ${quests.address})`,
      kills: sql<string>`coalesce(sum(${quests.progress}) filter (where ${quests.kind} = 'hunt'), 0)`,
    })
    .from(quests)
    .where(eq(quests.day, day))

  const [everybody] = await db.select({ count: sql<string>`count(*)` }).from(players)

  const money = await claimTotals(db)

  const recent = await db
    .select()
    .from(statsDaily)
    .where(lte(statsDaily.day, day))
    .orderBy(desc(statsDaily.day))
    .limit(HISTORY_DAYS)

  return {
    day,
    playersToday: toNumber(today?.players),
    playersAllTime: toNumber(everybody?.count),
    killsToday: toNumber(today?.kills),
    paidLuna: money.paidLuna,
    paidNim: lunaToNim(money.paidLuna),
    claimsPaid: money.paidCount,
    history: recent.reverse().map((row) => ({
      day: row.day,
      players: row.players,
      kills: row.kills,
      paidLuna: String(row.paidLuna),
    })),
  }
}

export type DailyBump = { players?: number; kills?: number; paidLuna?: bigint }

/**
 * Adds to one day's running totals, creating the row the first time. The three numbers are
 * added rather than set, so two processes counting at once cannot overwrite each other.
 * This table is the only record of a day once it is over, and publicStats reads the last
 * seven days of it straight back out, so a number written here is a number the page shows.
 */
export async function bumpDaily(db: Db, day: string, bump: DailyBump): Promise<void> {
  const addedPlayers = bump.players ?? 0
  const addedKills = bump.kills ?? 0
  const addedLuna = bump.paidLuna ?? 0n

  if (addedPlayers === 0 && addedKills === 0 && addedLuna === 0n) return

  await db
    .insert(statsDaily)
    .values({ day, players: addedPlayers, kills: addedKills, paidLuna: addedLuna })
    .onConflictDoUpdate({
      target: statsDaily.day,
      set: {
        players: sql`${statsDaily.players} + ${addedPlayers}`,
        kills: sql`${statsDaily.kills} + ${addedKills}`,
        paidLuna: sql`${statsDaily.paidLuna} + cast(${addedLuna.toString()} as bigint)`,
      },
    })
}

