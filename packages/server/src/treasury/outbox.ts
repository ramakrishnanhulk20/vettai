import { and, asc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { claims } from '../db/schema.js'
import { bumpDaily } from '../domain/stats.js'
import { utcDay } from '../lib/day.js'
import { sleep } from '../lib/sleep.js'
import type { Sender } from './sender.js'

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
 * How long a payout may hold a hash with no block before the node is asked one last
 * time. A Nimiq transaction is only valid for a couple of minutes after the height it
 * was built at, so a node that has still never heard of the hash by now never will.
 */
export const REJECTED_MS = 15 * 60 * 1000

/** How many times a payout is rebuilt before it is left on the record for Ram. */
export const MAX_ATTEMPTS = 3

export type DeliverySummary = {
  /** Payouts broadcast in this pass. */
  sent: number
  /** Payouts that were seen in a block in this pass. */
  paid: number
  /** Payouts given up on in this pass. They stay on the record for Ram to look at. */
  failed: number
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

type SettleSummary = { paid: number; requeued: number; failed: number; pending: number }

/**
 * Looks up every payout that is already on its way and decides what it is.
 *
 * A row with a hash is never simply sent again. The node is asked, and only three answers
 * are acted on: in a block, so the row is closed; never heard of, and old enough that a
 * valid transaction would have been mined long ago, so nothing was ever accepted and the
 * payout is rebuilt from scratch with a fresh validity height; anything else, including a
 * node that could not answer, which is left exactly as it is.
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
    .where(
      and(
        or(eq(claims.state, 'sending'), eq(claims.state, 'sent')),
        isNotNull(claims.txHash),
        isNull(claims.blockNumber),
      ),
    )
    .orderBy(asc(claims.createdAt))
    .limit(options.batch)

  const summary: SettleSummary = { paid: 0, requeued: 0, failed: 0, pending: 0 }

  for (const claim of inFlight) {
    if (!claim.txHash) continue

    const seen = await sender.lookup(claim.txHash)

    if ('blockNumber' in seen) {
      await db
        .update(claims)
        .set({ state: 'paid', blockNumber: seen.blockNumber, paidAt: now, error: null })
        .where(eq(claims.id, claim.id))

      await bumpDaily(db, utcDay(now), { paidLuna: claim.amountLuna })

      summary.paid += 1
      options.log(`paid claim=${claim.id} hash=${claim.txHash} block=${seen.blockNumber}`)
      continue
    }

    const waitingSince = claim.sentAt ?? claim.createdAt
    const rejected = 'unknown' in seen && now.getTime() - waitingSince.getTime() >= REJECTED_MS

    if (!rejected) {
      summary.pending += 1
      options.log(`still pending claim=${claim.id} hash=${claim.txHash}`)
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

    // The hash goes with it. It was never accepted, so there is nothing to look up any
    // more, and the next attempt has to be a new transaction with a fresh validity height.
    await db
      .update(claims)
      .set({
        state: 'queued',
        txHash: null,
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
 * Deals with a payout that was picked up but never got as far as a signed transaction,
 * which is what a crash in the middle of a pass leaves behind. With no hash there is
 * nothing on chain, so trying again is safe. Once, and then it is left alone for Ram.
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

  let failed = 0

  for (const claim of stale) {
    // No hash means the treasury never got as far as signing, so this is a different
    // failure from a broadcast the node refused: one more go, then a person looks at it.
    if (claim.attempts >= 1) {
      await db.update(claims).set({ state: 'failed' }).where(eq(claims.id, claim.id))
      failed += 1
      options.log(`gave up on claim=${claim.id} after one retry`)
      continue
    }

    await db
      .update(claims)
      .set({
        state: 'queued',
        sentAt: null,
        attempts: claim.attempts + 1,
        error: `attempt ${claim.attempts + 1}: ${claim.error ?? 'no hash after ten minutes'}`,
      })
      .where(eq(claims.id, claim.id))

    options.log(`retrying claim=${claim.id}, it never reached a signature`)
  }

  return failed
}

/**
 * One pass of the outbox: settle what is in flight, retry what stalled, then send the
 * oldest queued payouts.
 *
 * The order of writes is the whole point. A claim is moved to `sending` before any
 * network call, so a second process or a restart cannot pick it up again, and the hash is
 * written while it is still `sending`, before the broadcast. Every failure therefore
 * leaves either "no hash, nothing was sent" or "a hash, go and look it up", and neither
 * of those ever becomes a second payment.
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

  const summary: DeliverySummary = { sent: 0, paid: 0, failed: 0 }

  const settled = await settleInFlight(db, sender, now, settings)
  summary.paid += settled.paid
  summary.failed += settled.failed
  summary.failed += await sweepStale(db, now, settings)

  const queued = await db
    .select()
    .from(claims)
    .where(eq(claims.state, 'queued'))
    .orderBy(asc(claims.createdAt))
    .limit(settings.batch)

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
        onSigned: async (signedHash) => {
          await db.update(claims).set({ txHash: signedHash }).where(eq(claims.id, claim.id))
        },
      })

      await db.update(claims).set({ state: 'sent', sentAt: now, error: null }).where(eq(claims.id, claim.id))
      summary.sent += 1
      settings.log(`sent claim=${claim.id} to=${claim.address} hash=${hash}`)
    } catch (error) {
      const [current] = await db
        .select({ txHash: claims.txHash })
        .from(claims)
        .where(eq(claims.id, claim.id))
        .limit(1)

      await db
        .update(claims)
        .set({ error: `${claim.error ? `${claim.error} ` : ''}send failed: ${reason(error)}` })
        .where(eq(claims.id, claim.id))

      settings.log(
        current?.txHash
          ? `claim=${claim.id} was signed as ${current.txHash} before it failed, it will be looked up, not resent`
          : `claim=${claim.id} failed before signing: ${reason(error)}`,
      )
    }
  }

  // Nothing waits for a block while payouts are still going out: a queue of five used to
  // spend a minute of inclusion waits before the last one was even signed. The pass sends
  // everything first and only then closes what it can, and whatever has not landed by the
  // end of the window is closed by a later pass instead.
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

export type RunOptions = {
  intervalMs?: number
  log?: (line: string) => void
  signal?: AbortSignal
}

/** The treasury's delivery loop. One pass, wait, repeat, until the process is stopped. */
export async function runOutbox(db: Db, sender: Sender, options: RunOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 2000
  const log = options.log ?? ((line: string) => console.log(line))

  while (!options.signal?.aborted) {
    try {
      const summary = await deliverOnce(db, sender, new Date(), { log })
      if (summary.sent + summary.paid + summary.failed > 0) {
        log(`outbox sent ${summary.sent}, paid ${summary.paid}, failed ${summary.failed}`)
      }
    } catch (error) {
      log(`outbox pass failed: ${reason(error)}`)
    }

    await sleep(intervalMs)
  }
}
