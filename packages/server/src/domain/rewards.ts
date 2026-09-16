import { config } from '../config.js'
import { nimToLuna } from '../lib/luna.js'

/**
 * What each quest pays, in luna. The defaults are the numbers in ARCHITECTURE.md; every
 * one can be moved from the environment without a deploy, which is how Ram tunes the
 * economy once people are actually playing.
 */
export const rewards = {
  hunt: nimToLuna(config.REWARD_HUNT ?? '0.5'),
  courier: nimToLuna(config.REWARD_COURIER ?? '0.3'),
  landmarksFirst: nimToLuna(config.REWARD_LANDMARKS ?? '0.2'),
  landmarksRepeat: nimToLuna(config.REWARD_LANDMARKS_REPEAT ?? '0.05'),
  landlord: nimToLuna(config.REWARD_LANDLORD ?? '0.2'),
  ladder: parsePrizes(config.LADDER_PRIZES_NIM ?? '2,1,0.5'),
} as const

function parsePrizes(value: string): [bigint, bigint, bigint] {
  const parts = value.split(',').map((part) => nimToLuna(part.trim()))
  const [first, second, third] = parts
  if (parts.length !== 3 || first === undefined || second === undefined || third === undefined) {
    throw new Error(`LADDER_PRIZES_NIM needs three amounts, got "${value}"`)
  }
  return [first, second, third]
}

const STREAK_FIRST_DAY = nimToLuna('0.2')
const STREAK_STEP = nimToLuna('0.5')
const STREAK_CAP = nimToLuna('10')

/**
 * The daily streak curve, min(0.2 + 0.5 x (day - 1), 10) NIM, worked out in whole luna.
 * Day 1 is a player's first claimed day, so nothing below 1 is a real streak and asking
 * for one is a bug in the caller rather than a zero payout.
 */
export function streakReward(day: number): bigint {
  if (!Number.isInteger(day) || day < 1) throw new Error(`a streak day is a whole number from 1, got ${day}`)

  const earned = STREAK_FIRST_DAY + STREAK_STEP * BigInt(day - 1)
  return earned > STREAK_CAP ? STREAK_CAP : earned
}

/**
 * What a reward shrinks to once the wallet's day is taken into account. A streak that
 * would push the wallet past DAILY_CAP is written down at what is still left rather than
 * at the full curve, so a player is never shown a number the payout path would refuse.
 * At or over the cap the answer is zero, which is a quest with nothing to claim.
 */
export function clampToAllowance(reward: bigint, committedToday: bigint, dailyCap: bigint): bigint {
  const left = dailyCap - committedToday
  if (left <= 0n) return 0n
  return reward > left ? left : reward
}
