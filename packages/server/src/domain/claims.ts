import { and, asc, desc, eq, gte, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { config, dailyCapLuna, poolTotalLuna } from '../config.js'
import type { Db } from '../db/client.js'
import { claims, type Claim } from '../db/schema.js'
import { nextUtcMidnight, utcDayStart } from '../lib/day.js'

/** A transaction handed out by db.transaction, which reads and writes like the database. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type ClaimKind = 'hunt' | 'courier' | 'landmarks' | 'landlord' | 'streak' | 'ladder'

export type HoldReason = 'daily cap' | 'ip cap' | 'pool'

export type Limits = {
  dailyCapLuna?: bigint
  poolTotalLuna?: bigint
  ipWalletsPerDay?: number
}

export type QueueClaimInput = {
  address: string
  questId: string | null
  kind: ClaimKind
  amountLuna: bigint
  ipHash?: string | null
  /** Only a ladder prize needs this: a quest claim's memo is built from the quest id. */
  memo?: string
  now?: Date
  /** The caps, for a test that wants a small pool. The server passes nothing and gets .env. */
  limits?: Limits
}

/** How many held claims one release pass looks at, so a long queue cannot hold the loop. */
export const RELEASE_BATCH = 200

export type QueueClaimResult =
  | { state: 'queued'; claimId: string }
  | { state: 'held'; claimId: string; reason: HoldReason }
  | { state: 'refused'; claimId: string; reason: 'already claimed' }

/** The memo a payout carries on chain, so the quest it came from is public and checkable. */
export function claimMemo(questId: string): string {
  return `vettai:${questId.slice(0, 8)}`
}

/**
 * When a held claim is worth looking at again. The two day caps are a delay and nothing
 * more, so they wait for the next UTC midnight and the money is not forfeited. A fresh
 * pool hold waits for nothing, because room in the pool comes back the moment a committed
 * claim fails rather than at a time anybody can name.
 */
function heldUntilFor(reason: HoldReason, now: Date): Date | null {
  return reason === 'pool' ? null : nextUtcMidnight(now)
}

/**
 * The two locks every cap decision is made under, in the one order everybody takes them:
 * this wallet, then the pool.
 *
 * Without them two claims for the same wallet can both read "there is room" and both
 * write, which is how a cap is overrun by a race rather than by a bug. The locks are held
 * by the transaction, so they are gone the moment it commits or rolls back, and both
 * Postgres and PGlite take them.
 */
async function lockForClaim(tx: Tx, address: string): Promise<void> {
  // Pool first, then the wallet, the same order payLadder uses. Two transactions that
  // take these in different orders could each wait on the other forever.
  await tx.execute(sql`select pg_advisory_xact_lock(0)`)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${address}))`)
}

function toBigInt(value: unknown): bigint {
  if (value == null) return 0n
  return BigInt(String(value).split('.')[0] ?? '0')
}

/** What this wallet has already had granted today, across every reward kind, in luna. */
export async function committedToday(dbOrTx: Db | Tx, address: string, now: Date): Promise<bigint> {
  const [row] = await (dbOrTx as Db)
    .select({ total: sql<string>`coalesce(sum(${claims.amountLuna}), 0)` })
    .from(claims)
    .where(
      and(
        eq(claims.address, address),
        sql`${claims.state} in ('queued', 'sending', 'sent', 'paid')`,
        gte(claims.createdAt, utcDayStart(now)),
        lt(claims.createdAt, nextUtcMidnight(now)),
      ),
    )

  return toBigInt(row?.total)
}

async function walletsFromIpToday(tx: Tx, ipHash: string, address: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ wallets: sql<string>`count(distinct ${claims.address})` })
    .from(claims)
    .where(
      and(
        eq(claims.ipHash, ipHash),
        ne(claims.address, address),
        // A held claim was never granted, so the wallet behind it has taken nothing and
        // must not count towards the house's share of the day.
        sql`${claims.state} in ('queued', 'sending', 'sent', 'paid')`,
        gte(claims.createdAt, utcDayStart(now)),
        lt(claims.createdAt, nextUtcMidnight(now)),
      ),
    )

  return Number(row?.wallets ?? 0)
}

async function committedEver(tx: Tx): Promise<bigint> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${claims.amountLuna}), 0)` })
    .from(claims)
    .where(sql`${claims.state} in ('queued', 'sending', 'sent', 'paid')`)

  return toBigInt(row?.total)
}

/**
 * Works out whether this claim may be paid, in the order a person would ask it: has
 * this wallet had its day's worth, is this one house running several wallets, and is
 * there anything left in the pool at all. The first cap that says no is the reason,
 * because a player is told one thing rather than a list.
 */
type CapInput = {
  address: string
  amountLuna: bigint
  ipHash?: string | null | undefined
  limits?: Limits | undefined
}

async function holdReason(tx: Tx, input: CapInput, now: Date): Promise<HoldReason | null> {
  const limits = input.limits ?? {}
  const daily = limits.dailyCapLuna ?? dailyCapLuna
  const pool = limits.poolTotalLuna ?? poolTotalLuna
  const ipWallets = limits.ipWalletsPerDay ?? config.IP_WALLETS_PER_DAY

  if ((await committedToday(tx, input.address, now)) + input.amountLuna > daily) return 'daily cap'

  if (input.ipHash) {
    if ((await walletsFromIpToday(tx, input.ipHash, input.address, now)) >= ipWallets) return 'ip cap'
  }

  if ((await committedEver(tx)) + input.amountLuna > pool) return 'pool'

  return null
}

/**
 * Queues one payout, or writes down why it was held, inside a transaction the caller
 * already owns. Used by the ladder, which has to insert its period row and its three
 * prizes as one unit. Everything else calls queueClaim.
 */
export async function queueClaimIn(tx: Tx, input: QueueClaimInput): Promise<QueueClaimResult> {
  if (input.amountLuna <= 0n) throw new Error('a claim has to be worth more than nothing')

  const memo = input.memo ?? (input.questId ? claimMemo(input.questId) : null)
  if (!memo) throw new Error('a claim with no quest behind it has to bring its own memo')

  const now = input.now ?? new Date()

  await lockForClaim(tx, input.address)
  const reason = await holdReason(tx, input, now)

  // The partial unique index on quest_id is what actually stops a double payout: two
  // requests can both read "this quest is done" and both get here, but only one row can
  // exist. Letting the database refuse it, rather than throwing, keeps the caller's
  // transaction alive so it can answer with the claim that already exists.
  const [row] = await tx
    .insert(claims)
    .values({
      address: input.address,
      questId: input.questId,
      kind: input.kind,
      amountLuna: input.amountLuna,
      state: reason ? 'held' : 'queued',
      memo,
      ipHash: input.ipHash ?? null,
      createdAt: now,
      heldUntil: reason ? heldUntilFor(reason, now) : null,
      error: reason,
    })
    .onConflictDoNothing({ target: claims.questId, where: sql`quest_id is not null` })
    .returning({ id: claims.id })

  if (!row) {
    if (!input.questId) throw new Error('the claim was not written')

    const [existing] = await tx
      .select({ id: claims.id })
      .from(claims)
      .where(eq(claims.questId, input.questId))
      .limit(1)

    if (!existing) throw new Error('the claim was not written')
    return { state: 'refused', claimId: existing.id, reason: 'already claimed' }
  }

  return reason ? { state: 'held', claimId: row.id, reason } : { state: 'queued', claimId: row.id }
}

/**
 * The only way a payout is ever created.
 *
 * Everything happens in one transaction: the three caps are measured and the row is
 * written before anybody else can read the same totals. A claim that fails a cap is
 * still written down, as `held` with the reason in `error`, so a player can see it and
 * Ram can review it, and so the money is not quietly lost. A quest that already has a
 * claim is refused by the database, never by a check that another request could have
 * raced past.
 */
export async function queueClaim(db: Db, input: QueueClaimInput): Promise<QueueClaimResult> {
  return db.transaction((tx) => queueClaimIn(tx, input))
}

export type ReleaseSummary = {
  /** Held claims that passed the caps this time and are now queued to be paid. */
  released: number
  /** Held claims that are still over a cap. Every one of them is looked at again later. */
  stillHeld: number
}

/**
 * Gives every held claim another chance, which is what turns a cap into a delay.
 *
 * A wallet that hit its daily cap yesterday is under it again today, so the claim it was
 * holding is queued rather than lost. Each claim is re-measured under the same two locks
 * queueClaim uses, so a release cannot overrun a cap either. The released claim is
 * re-dated to now on purpose: the daily cap counts a wallet's claims by the day they
 * entered the queue, and a claim released today has to count against today.
 */
export async function releaseHeld(db: Db, now: Date = new Date(), limits?: Limits): Promise<ReleaseSummary> {
  const due = await db
    .select()
    .from(claims)
    .where(and(eq(claims.state, 'held'), or(isNull(claims.heldUntil), lte(claims.heldUntil, now))))
    .orderBy(asc(claims.createdAt))
    .limit(RELEASE_BATCH)

  const summary: ReleaseSummary = { released: 0, stillHeld: 0 }

  for (const claim of due) {
    const freed = await db.transaction(async (tx) => {
      await lockForClaim(tx, claim.address)

      const reason = await holdReason(
        tx,
        { address: claim.address, amountLuna: claim.amountLuna, ipHash: claim.ipHash, limits },
        now,
      )

      if (reason) {
        await tx
          .update(claims)
          .set({ heldUntil: nextUtcMidnight(now), error: reason })
          .where(and(eq(claims.id, claim.id), eq(claims.state, 'held')))
        return false
      }

      const [flipped] = await tx
        .update(claims)
        .set({ state: 'queued', heldUntil: null, error: null, createdAt: now })
        .where(and(eq(claims.id, claim.id), eq(claims.state, 'held')))
        .returning({ id: claims.id })

      return flipped !== undefined
    })

    if (freed) summary.released += 1
    else summary.stillHeld += 1
  }

  return summary
}

/** Everything this wallet has claimed, newest first, for GET /api/claims. */
export function listClaims(db: Db, address: string): Promise<Claim[]> {
  return db.select().from(claims).where(eq(claims.address, address)).orderBy(desc(claims.createdAt))
}

export type ClaimTotals = {
  paidLuna: bigint
  paidCount: number
  committedLuna: bigint
  queuedCount: number
  heldCount: number
  poolLeftLuna: bigint
}

/** The numbers the public stats page reads. Every one of them is counted from the rows. */
export async function claimTotals(db: Db): Promise<ClaimTotals> {
  const [row] = await db
    .select({
      paid: sql<string>`coalesce(sum(${claims.amountLuna}) filter (where ${claims.state} = 'paid'), 0)`,
      paidCount: sql<string>`count(*) filter (where ${claims.state} = 'paid')`,
      committed: sql<string>`coalesce(sum(${claims.amountLuna}) filter (where ${claims.state} in ('queued', 'sending', 'sent', 'paid')), 0)`,
      queuedCount: sql<string>`count(*) filter (where ${claims.state} in ('queued', 'sending', 'sent'))`,
      heldCount: sql<string>`count(*) filter (where ${claims.state} = 'held')`,
    })
    .from(claims)

  const committedLuna = toBigInt(row?.committed)
  const left = poolTotalLuna - committedLuna

  return {
    paidLuna: toBigInt(row?.paid),
    paidCount: Number(row?.paidCount ?? 0),
    committedLuna,
    queuedCount: Number(row?.queuedCount ?? 0),
    heldCount: Number(row?.heldCount ?? 0),
    poolLeftLuna: left > 0n ? left : 0n,
  }
}
