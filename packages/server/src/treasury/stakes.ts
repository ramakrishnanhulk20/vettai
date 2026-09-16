import { and, eq, isNull } from 'drizzle-orm'
import { landlordMinLuna } from '../config.js'
import type { Db } from '../db/client.js'
import { players, quests } from '../db/schema.js'
import { utcDay } from '../lib/day.js'
import { sleep } from '../lib/sleep.js'
import { isNoStaker, type RpcStaker } from '../nimiq/rpc.js'

/** The public node is shared with everybody, so wallets are read one after another. */
export const STAGGER_MS = 150

/** A day's worth of landlord quests, so a broken node cannot hold the job open forever. */
export const MAX_PER_RUN = 200

export type StakesRpc = {
  getStakerByAddress: (address: string) => Promise<RpcStaker>
}

export type StakesOptions = {
  log?: (line: string) => void
  staggerMs?: number
  limit?: number
  minStakeLuna?: bigint
}

/**
 * Whether the stake read is due. It runs once per UTC day, because that is the day a
 * landlord quest belongs to: a plain 24 hour timer drifts off midnight and a restart
 * would start the clock again, so a day that was already read could be read twice or
 * missed altogether.
 */
export function shouldReadStakes(lastDayRun: string | null, now: Date): boolean {
  return lastDayRun !== utcDay(now)
}

export type StakesSummary = {
  checked: number
  completed: number
  failed: number
}

/**
 * What this wallet has actively staked, in luna.
 *
 * Zero covers both "never staked" and "staked nothing": the node answers a wallet with no
 * staker record with an error rather than with an empty one, and that error is an answer,
 * not a failure. Only the active balance counts. Stake being unwound (inactive or
 * retired) is on its way out of staking, so it is not what the landlord quest asks for.
 */
export async function readStakeLuna(rpc: StakesRpc, address: string): Promise<bigint> {
  try {
    const staker = await rpc.getStakerByAddress(address)
    return BigInt(Math.trunc(staker.balance ?? 0))
  } catch (error) {
    if (isNoStaker(error)) return 0n
    throw error
  }
}

/**
 * Finishes the landlord quest for everybody who is staking enough, once a day.
 *
 * This is the one quest the game cannot see: staking happens in the wallet, not in the
 * city, so the only honest way to know is to ask the chain. A wallet the node cannot
 * answer for is left open and tried again tomorrow, never marked done on a guess.
 */
export async function completeLandlordQuests(
  db: Db,
  rpc: StakesRpc,
  now: Date = new Date(),
  options: StakesOptions = {},
): Promise<StakesSummary> {
  const log = options.log ?? ((line: string) => console.log(line))
  const staggerMs = options.staggerMs ?? STAGGER_MS
  const minimum = options.minStakeLuna ?? landlordMinLuna

  // Only today's quest. Without the day, one stake read finished every open landlord
  // quest a wallet had ever left behind, so one stake paid several days of reward.
  const day = utcDay(now)

  const open = await db
    .selectDistinct({ address: quests.address })
    .from(quests)
    .where(and(eq(quests.kind, 'landlord'), eq(quests.state, 'open'), eq(quests.day, day)))
    .limit(options.limit ?? MAX_PER_RUN)

  const summary: StakesSummary = { checked: 0, completed: 0, failed: 0 }

  for (const [index, row] of open.entries()) {
    if (index > 0 && staggerMs > 0) await sleep(staggerMs)

    try {
      const staked = await readStakeLuna(rpc, row.address)
      summary.checked += 1
      if (staked < minimum) continue

      const done = await db
        .update(quests)
        .set({ state: 'done', doneAt: now, progress: 1 })
        .where(
          and(
            eq(quests.address, row.address),
            eq(quests.kind, 'landlord'),
            eq(quests.state, 'open'),
            eq(quests.day, day),
          ),
        )
        .returning({ id: quests.id })

      await db
        .update(players)
        .set({ landlordSince: now })
        .where(and(eq(players.address, row.address), isNull(players.landlordSince)))

      summary.completed += done.length
      log(`landlord quest done for ${row.address}, staked ${staked} luna`)
    } catch (error) {
      summary.failed += 1
      log(`could not read the stake of ${row.address}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return summary
}
