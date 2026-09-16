/**
 * One reading of what day it is, shared by everything that counts a day.
 *
 * Every cap, every quest and every daily total is filed under a UTC date, never the
 * server's local one, so a player in Chennai and a player in Berlin get the same day and
 * a machine moved to another region does not hand anybody a second daily allowance.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/** The date a moment falls on, as YYYY-MM-DD in UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Midnight UTC at the start of the day a moment falls on. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** The next midnight UTC, which is the moment a daily cap lets go of a held claim. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + DAY_MS)
}
