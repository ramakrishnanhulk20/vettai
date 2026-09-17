import { and, asc, eq, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { claims, type Claim } from '../db/schema.js'
import { bumpDaily } from '../domain/stats.js'
import { utcDay } from '../lib/day.js'
import { sleep } from '../lib/sleep.js'
import type { ChainTransaction } from '../nimiq/rpc.js'
import { FINALITY_BLOCKS, VALIDITY_WINDOW_BLOCKS, type Sender } from './sender.js'

/** How many payouts leave in one pass. Small, because each one is a separate signed send. */
export const BATCH = 5

/** The gap between two sends. Nimiq has no batch transaction, so N payouts are N sends. */
export const SEND_SPACING_MS = 1500

/** How long a payout may sit in `sending` with no hash before it is tried again. */
export const STALE_MS = 10 * 60 * 1000

/** How long one pass waits at the end for the payments it just sent to land. */
export const INCLUSION_MS = 20_000

/** The gap between two looks at what is in flight while a pass is closing. */
export const SETTLE_POLL_MS = 2000

/**
 * The floor on how long a payout may hold a hash with no block before the treasury starts
 * asking whether it was ever accepted. It is a floor and not the whole rule: the chain's own
 * validity window, the node's mempool and the treasury's outgoing history all have to agree
 * before anything is rebuilt.
 */
export const REJECTED_MS = 3 * 60 * 60 * 1000

/** How many times a payout is rebuilt before it is left on the record for Ram. */
export const MAX_ATTEMPTS = 3

/** How long a payout waits after a failure that never reached a signature. */
export const FIRST_BACKOFF_MS = 2 * 60 * 1000

/** The ceiling that wait doubles up to. A node that is down for an hour is asked twice. */
export const MAX_BACKOFF_MS = 30 * 60 * 1000

/** How often the treasury says out loud that the wallet is short of what it owes. */
export const LOW_BALANCE_QUIET_MS = 60_000

export type DeliverySummary = {
  /** Payouts broadcast in this pass. */
  sent: number
  /** Payouts that reached enough confirmations in this pass. */
  paid: number
  /** Payouts given up on in this pass. They stay on the record for Ram to look at. */
  failed: number
  /** What the wallet held when this pass read it, or null when this pass did not read it. */
  balanceLuna: bigint | null
  /** Queued plus sending, which is what the wallet has to cover. */
  committedLuna: bigint | null
}

export type DeliverOptions = {
  log?: (line: string) => void
  spacingMs?: number
  batch?: number
  inclusionMs?: number
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type SettleSummary = {
  paid: number
  requeued: number
  failed: number
  /** Broadcast payouts the chain has not carried yet. These are what a pass waits on. */
  pending: number
  /** Payouts in a block that is not buried deep enough to be called final. */
  settling: number
}

/**
 * The wait before the next go at a payout that failed before it was ever signed.
 *
 * Nothing about it reached the chain, so this is patience with a node rather than a penalty,
 * and it must not touch `attempts`. The previous wait is read back off the row itself: a
 * pass stamps `sent_at` when it picks a payout up and `next_attempt_at` when it puts it
 * back, so the gap between them is exactly the wait that was used last time.
 */
export function nextBackoffMs(claim: Pick<Claim, 'sentAt' | 'nextAttemptAt'>): number {
  const previous =
    claim.sentAt && claim.nextAttemptAt ? claim.nextAttemptAt.getTime() - claim.sentAt.getTime() : 0

  if (previous <= 0) return FIRST_BACKOFF_MS
  return Math.min(MAX_BACKOFF_MS, previous * 2)
}

/** Money the treasury has promised and not yet put on the chain, in luna. */
export async function committedOutLuna(db: Db): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${claims.amountLuna}), 0)` })
    .from(claims)
    .where(sql`${claims.state} in ('queued', 'sending')`)

  return BigInt(String(row?.total ?? '0').split('.')[0] ?? '0')
}

/** True when a payment is buried deep enough that the chain will not take it back. */
export function isFinal(blockNumber: number, head: number, confirmations?: number): boolean {
  if (confirmations !== undefined && confirmations > 0) return confirmations >= FINALITY_BLOCKS
  return head >= blockNumber + FINALITY_BLOCKS
}

type RebuildVerdict = { rebuild: true } | { alreadyPaid: ChainTransaction } | { wait: string }

/**
 * Whether a payout holding a hash the node has never heard of may be built again.
 *
 * This is the one decision in Vettai that could pay somebody twice, so it takes four
 * separate yeses and any single doubt is a no. The hash has been sitting long enough
 * (REJECTED_MS); the chain can no longer accept that transaction at all, because the head is
 * past its validity window with a batch to spare; the node is not holding it in its own
 * mempool, which rpc.nimiqwatch.com reports as "not found" and would otherwise read as a
 * refusal; and the treasury's own outgoing history since that height carries no payment with
 * this memo. If the history does carry it, the payout was made, and the row is closed
 * against the transaction that really happened rather than sent again.
 */
async function rebuildVerdict(
  sender: Sender,
  claim: Claim,
  head: number,
  now: Date,
): Promise<RebuildVerdict> {
  const waitingSince = claim.sentAt ?? claim.createdAt
  if (now.getTime() - waitingSince.getTime() < REJECTED_MS) return { wait: 'it is not old enough' }

  const start = claim.validityStartHeight
  if (start === null) {
    return { wait: 'no validity height was written down, so a person has to settle it' }
  }

  const closed = start + VALIDITY_WINDOW_BLOCKS + FINALITY_BLOCKS
  if (head < closed) return { wait: `the chain can still accept it until block ${closed}` }

  if (claim.txHash && (await sender.mempoolHas(claim.txHash))) {
    return { wait: 'the node is still holding it in the mempool' }
  }

  const outgoing = await sender.outgoingSince(start)
  const found = outgoing.find((tx) => tx.memo === claim.memo)
  if (found) return { alreadyPaid: found }

  return { rebuild: true }
}

/**
 * Looks up every payout that is already on its way and decides what it is.
 *
 * A row with a hash is never simply sent again. In a block and buried under a batch is paid;
 * in a block and shallower than that is written down and left alone until it is final; never
 * heard of goes to rebuildVerdict, which needs the chain, the mempool and the treasury's own
 * history to agree before anything is rebuilt; anything else, a node that could not answer
 * included, is left exactly as it is.
 */
async function settleInFlight(
  db: Db,
  sender: Sender,
  now: Date,
  options: Required<Pick<DeliverOptions, 'log' | 'batch'>>,
): Promise<SettleSummary> {
  const inFlight = await db
    .select()
    .from(claims)
    .where(and(or(eq(claims.state, 'sending'), eq(claims.state, 'sent')), isNotNull(claims.txHash)))
    .orderBy(asc(claims.createdAt))
    .limit(options.batch)

  const summary: SettleSummary = { paid: 0, requeued: 0, failed: 0, pending: 0, settling: 0 }
  if (inFlight.length === 0) return summary

  let head: number | null = null
  const headOnce = async (): Promise<number> => {
    head ??= await sender.head()
    return head
  }

  const pay = async (claim: Claim, hash: string, blockNumber: number): Promise<void> => {
    await db
      .update(claims)
      .set({ state: 'paid', txHash: hash, blockNumber, paidAt: now, error: null })
      .where(eq(claims.id, claim.id))

    await bumpDaily(db, utcDay(now), { paidLuna: claim.amountLuna })

    summary.paid += 1
    options.log(`paid claim=${claim.id} hash=${hash} block=${blockNumber}`)
  }

  for (const claim of inFlight) {
    if (!claim.txHash) continue

    // A block was recorded on an earlier pass, so all that is left to decide is depth.
    if (claim.blockNumber !== null) {
      if (isFinal(claim.blockNumber, await headOnce())) {
        await pay(claim, claim.txHash, claim.blockNumber)
      } else {
        summary.settling += 1
      }
      continue
    }

    const seen = await sender.lookup(claim.txHash)

    if ('blockNumber' in seen) {
      if (isFinal(seen.blockNumber, await headOnce(), seen.confirmations)) {
        await pay(claim, claim.txHash, seen.blockNumber)
        continue
      }

      await db
        .update(claims)
        .set({ state: 'sent', blockNumber: seen.blockNumber, error: null })
        .where(eq(claims.id, claim.id))

      summary.settling += 1
      options.log(`claim=${claim.id} is in block ${seen.blockNumber}, ${FINALITY_BLOCKS} to go`)
      continue
    }

    if ('pending' in seen) {
      summary.pending += 1
      options.log(`still pending claim=${claim.id} hash=${claim.txHash}`)
      continue
    }

    const verdict = await rebuildVerdict(sender, claim, await headOnce(), now)

    if ('wait' in verdict) {
      summary.pending += 1
      options.log(`still pending claim=${claim.id} hash=${claim.txHash}: ${verdict.wait}`)
      continue
    }

    if ('alreadyPaid' in verdict) {
      await pay(claim, verdict.alreadyPaid.hash, verdict.alreadyPaid.blockNumber)
      options.log(`claim=${claim.id} was already paid on chain as ${verdict.alreadyPaid.hash}`)
      continue
    }

    const attempts = claim.attempts + 1

    if (attempts >= MAX_ATTEMPTS) {
      await db
        .update(claims)
        .set({ state: 'failed', attempts, error: `the node never accepted ${claim.txHash}` })
        .where(and(eq(claims.id, claim.id), eq(claims.txHash, claim.txHash)))

      summary.failed += 1
      options.log(`gave up on claim=${claim.id} after ${attempts} attempt(s) the node never took`)
      continue
    }

    // The hash goes with it. It was never accepted, the chain will not take it any more, and
    // the next attempt has to be a new transaction with a fresh validity height.
    await db
      .update(claims)
      .set({
        state: 'queued',
        txHash: null,
        validityStartHeight: null,
        sentAt: null,
        attempts,
        error: `attempt ${attempts}: the node did not know ${claim.txHash}`,
      })
      .where(and(eq(claims.id, claim.id), eq(claims.txHash, claim.txHash)))

    summary.requeued += 1
    options.log(`rebuilding claim=${claim.id}, the node never heard of ${claim.txHash}`)
  }

  return summary
}

/**
 * Deals with a payout that was picked up but never got as far as a signed transaction, which
 * is what a crash in the middle of a pass leaves behind. With no hash there is nothing on
 * chain, so another go is safe and costs nobody anything. It waits rather than failing,
 * because the money is owed either way and `attempts` belongs to broadcasts.
 */
async function sweepStale(
  db: Db,
  now: Date,
  options: Required<Pick<DeliverOptions, 'log'>>,
): Promise<number> {
  const stale = await db
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.state, 'sending'),
        isNull(claims.txHash),
        lt(claims.sentAt, new Date(now.getTime() - STALE_MS)),
      ),
    )

  for (const claim of stale) {
    const wait = nextBackoffMs(claim)

    await db
      .update(claims)
      .set({
        state: 'queued',
        nextAttemptAt: new Date(now.getTime() + wait),
        error: claim.error ?? 'no hash after ten minutes',
      })
      .where(and(eq(claims.id, claim.id), eq(claims.state, 'sending')))

    options.log(
      `claim=${claim.id} never reached a signature, another go in ${Math.round(wait / 60000)} min`,
    )
  }

  return stale.length
}

/** When the treasury last said the wallet was short, so it says it once a minute. */
let lastShortWarningMs = 0

/**
 * One pass of the outbox: settle what is in flight, wait out what stalled, check the wallet
 * covers what is owed, then send the oldest queued payouts.
 *
 * The order of writes is the whole point. A claim is moved to `sending` before any network
 * call, so a second process or a restart cannot pick it up again, and the hash and the height
 * it was built at are written while it is still `sending`, before the broadcast. Every
 * failure therefore leaves either "no hash, nothing was sent" or "a hash, go and look it
 * up", and neither of those ever becomes a second payment.
 */
export async function deliverOnce(
  db: Db,
  sender: Sender,
  now: Date = new Date(),
  options: DeliverOptions = {},
): Promise<DeliverySummary> {
  const settings = {
    log: options.log ?? (() => {}),
    spacingMs: options.spacingMs ?? SEND_SPACING_MS,
    batch: options.batch ?? BATCH,
    inclusionMs: options.inclusionMs ?? INCLUSION_MS,
  }

  const summary: DeliverySummary = {
    sent: 0,
    paid: 0,
    failed: 0,
    balanceLuna: null,
    committedLuna: null,
  }

  const settled = await settleInFlight(db, sender, now, settings)
  summary.paid += settled.paid
  summary.failed += settled.failed
  await sweepStale(db, now, settings)

  const queued = await db
    .select()
    .from(claims)
    .where(
      and(eq(claims.state, 'queued'), or(isNull(claims.nextAttemptAt), lte(claims.nextAttemptAt, now))),
    )
    .orderBy(asc(claims.createdAt))
    .limit(settings.batch)

  summary.committedLuna = await committedOutLuna(db)

  // The wallet is read from the chain before anything is signed, never from a number we keep
  // ourselves. An idle treasury reads it once a minute instead, which keeps the health page
  // current and is gentle on a public node that is already polled every two seconds.
  const due = queued.length > 0
  const quietFor = now.getTime() - lastShortWarningMs
  if (due || quietFor >= LOW_BALANCE_QUIET_MS) summary.balanceLuna = await sender.balanceLuna()

  const first = queued[0]

  if (due && first && summary.balanceLuna !== null) {
    const needed = summary.committedLuna + first.amountLuna

    if (summary.balanceLuna < needed) {
      if (quietFor >= LOW_BALANCE_QUIET_MS) {
        lastShortWarningMs = now.getTime()
        settings.log(
          `wallet below committed: ${summary.balanceLuna} luna held against ${needed} luna owed, ` +
            `nothing is sent until it is topped up`,
        )
      }
      return summary
    }
  }

  for (const [index, claim] of queued.entries()) {
    const [taken] = await db
      .update(claims)
      .set({ state: 'sending', sentAt: now })
      .where(and(eq(claims.id, claim.id), eq(claims.state, 'queued')))
      .returning({ id: claims.id })

    // Somebody else took it between the read and the write, which is what the condition
    // is there for.
    if (!taken) continue

    if (index > 0 && settings.spacingMs > 0) await sleep(settings.spacingMs)

    try {
      const { hash } = await sender.send({
        to: claim.address,
        valueLuna: claim.amountLuna,
        memo: claim.memo,
        onSigned: async (signedHash, validityStartHeight) => {
          await db
            .update(claims)
            .set({ txHash: signedHash, validityStartHeight })
            .where(eq(claims.id, claim.id))
        },
      })

      await db
        .update(claims)
        .set({ state: 'sent', sentAt: now, error: null, nextAttemptAt: null })
        .where(eq(claims.id, claim.id))

      summary.sent += 1
      settings.log(`sent claim=${claim.id} to=${claim.address} hash=${hash}`)
    } catch (error) {
      const [current] = await db
        .select({ txHash: claims.txHash })
        .from(claims)
        .where(eq(claims.id, claim.id))
        .limit(1)

      if (current?.txHash) {
        await db
          .update(claims)
          .set({ error: `${claim.error ? `${claim.error} ` : ''}send failed: ${reason(error)}` })
          .where(eq(claims.id, claim.id))

        settings.log(
          `claim=${claim.id} was signed as ${current.txHash} before it failed, it is looked up, not resent`,
        )
        continue
      }

      // Nothing was signed, so nothing can be on chain. That is a node that hiccupped, and
      // the payout waits instead of spending one of its three rebuild attempts.
      const wait = nextBackoffMs(claim)
      await db
        .update(claims)
        .set({
          state: 'queued',
          nextAttemptAt: new Date(now.getTime() + wait),
          error: `send failed before signing: ${reason(error)}`,
        })
        .where(and(eq(claims.id, claim.id), eq(claims.state, 'sending')))

      settings.log(
        `claim=${claim.id} failed before signing: ${reason(error)}, another go in ${Math.round(wait / 60000)} min`,
      )
    }
  }

  // Nothing waits for a block while payouts are still going out: a queue of five used to
  // spend a minute of inclusion waits before the last one was even signed. The pass sends
  // everything first and only then closes what it can, and whatever has not landed by the end
  // of the window is closed by a later pass instead. Nothing waits here for finality either:
  // a batch takes about a minute, and a later pass is the right place for it.
  if (summary.sent > 0) {
    const deadline = Date.now() + settings.inclusionMs

    // What is still pending was already said once at the top of this pass, so the closing
    // looks keep quiet about it and a stuck payout does not fill the log every two seconds.
    const closingSettings = {
      ...settings,
      log: (line: string) => {
        if (!line.startsWith('still pending')) settings.log(line)
      },
    }

    for (;;) {
      const closing = await settleInFlight(db, sender, now, closingSettings)
      summary.paid += closing.paid
      summary.failed += closing.failed

      if (closing.pending === 0 || Date.now() >= deadline) break
      await sleep(SETTLE_POLL_MS)
    }
  }

  return summary
}

export type PassInfo = {
  at: Date
  balanceLuna: bigint | null
  committedLuna: bigint | null
  /** False when the pass could not reach the node at all. */
  nodeOk: boolean
}

export type RunOptions = {
  intervalMs?: number
  log?: (line: string) => void
  signal?: AbortSignal
  /** Called after every pass, so the treasury health page can show what it saw. */
  onPass?: (info: PassInfo) => void
}

/** The treasury delivery loop. One pass, wait, repeat, until the process is stopped. */
export async function runOutbox(db: Db, sender: Sender, options: RunOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 2000
  const log = options.log ?? ((line: string) => console.log(line))

  while (!options.signal?.aborted) {
    try {
      const summary = await deliverOnce(db, sender, new Date(), { log })
      if (summary.sent + summary.paid + summary.failed > 0) {
        log(`outbox sent ${summary.sent}, paid ${summary.paid}, failed ${summary.failed}`)
      }
      options.onPass?.({
        at: new Date(),
        balanceLuna: summary.balanceLuna,
        committedLuna: summary.committedLuna,
        nodeOk: true,
      })
    } catch (error) {
      log(`outbox pass failed: ${reason(error)}`)
      options.onPass?.({ at: new Date(), balanceLuna: null, committedLuna: null, nodeOk: false })
    }

    await sleep(intervalMs, options.signal)
  }
}
