import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import type { Db } from '../db/client.js'
import { receivedPayments, watchCursor } from '../db/schema.js'
import { expireOrders, markPaid, type MarkPaidRefusal } from '../domain/shop.js'
import { sleep } from '../lib/sleep.js'
import type { ChainTransaction } from '../nimiq/rpc.js'

/** The memo every shop payment carries. Anything else into the treasury is not an order. */
export const SHOP_PREFIX = 'vettai:shop:'

/** How far back the watcher reads the very first time it runs against an address. */
export const LOOKBACK_BLOCKS = 100

export type WatcherRpc = {
  getBlockNumber: () => Promise<number>
  listIncoming: (address: string, sinceBlock: number) => Promise<ChainTransaction[]>
}

/** What Vettai decided about one payment that arrived. Every one of these is written down. */
export type PaymentOutcome =
  | 'paid'
  | 'short'
  | 'expired'
  | 'unknown_memo'
  | 'sender_mismatch'
  | 'already_paid'

const OUTCOMES: Record<MarkPaidRefusal, PaymentOutcome> = {
  'unknown memo': 'unknown_memo',
  'already paid': 'already_paid',
  expired: 'expired',
  'sender mismatch': 'sender_mismatch',
  'short payment': 'short',
}

export type WatchSummary = {
  paid: number
  skipped: number
  expired: number
  cursor: number
}

export type WatchOptions = {
  address?: string
  log?: (line: string) => void
  lookbackBlocks?: number
  now?: Date
}

/**
 * Writes down a payment and what was decided about it.
 *
 * Money that arrived is money that arrived, whether or not it bought anything, so the
 * refusals matter more than the successes: they are what Ram settles by hand. The hash is
 * the key, so reading the same block twice keeps the first decision rather than writing a
 * second row.
 */
async function record(
  db: Db,
  tx: ChainTransaction,
  outcome: PaymentOutcome,
  orderId: string | null,
  now: Date,
): Promise<void> {
  await db
    .insert(receivedPayments)
    .values({
      txHash: tx.hash,
      sender: tx.sender,
      recipient: tx.recipient,
      valueLuna: tx.valueLuna,
      memo: tx.memo,
      blockNumber: tx.blockNumber,
      blockTime: tx.blockTime,
      orderId,
      outcome,
      seenAt: now,
    })
    .onConflictDoNothing({ target: receivedPayments.txHash })
}

async function cursorFor(db: Db, address: string, rpc: WatcherRpc, lookbackBlocks: number): Promise<number> {
  const [existing] = await db.select().from(watchCursor).where(eq(watchCursor.address, address)).limit(1)
  if (existing?.lastBlockNumber != null) return existing.lastBlockNumber

  const head = await rpc.getBlockNumber()
  const start = Math.max(0, head - lookbackBlocks)

  const [created] = await db
    .insert(watchCursor)
    .values({ address, lastBlockNumber: start })
    .onConflictDoNothing({ target: watchCursor.address })
    .returning({ lastBlockNumber: watchCursor.lastBlockNumber })

  return created?.lastBlockNumber ?? start
}

/**
 * One pass over the money coming in: read what is new for the treasury address, settle
 * every payment that names a shop order, and move the cursor to the last block read.
 *
 * The cursor moves over skipped payments as well as paid ones, because a payment with no
 * order behind it will never become one and reading it again every three seconds would
 * only cost the node. Nothing is lost by that: a payment is settled at most once anyway,
 * since the order's memo is unique and the order stops being pending the moment it is
 * paid, so the same transaction arriving twice is a no-op rather than a second grant.
 */
export async function tick(db: Db, rpc: WatcherRpc, options: WatchOptions = {}): Promise<WatchSummary> {
  const address = options.address ?? config.TREASURY_ADDRESS
  const log = options.log ?? ((line: string) => console.log(line))
  const now = options.now ?? new Date()

  const summary: WatchSummary = {
    paid: 0,
    skipped: 0,
    expired: await expireOrders(db, now),
    cursor: await cursorFor(db, address, rpc, options.lookbackBlocks ?? LOOKBACK_BLOCKS),
  }

  const incoming = await rpc.listIncoming(address, summary.cursor)
  let furthest = summary.cursor

  for (const tx of incoming) {
    furthest = Math.max(furthest, tx.blockNumber)

    if (!tx.memo?.startsWith(SHOP_PREFIX)) {
      await record(db, tx, 'unknown_memo', null, now)
      summary.skipped += 1
      log(`skipped hash=${tx.hash} block=${tx.blockNumber}: not a shop payment`)
      continue
    }

    const result = await markPaid(db, {
      memo: tx.memo,
      txHash: tx.hash,
      sender: tx.sender,
      valueLuna: tx.valueLuna,
      blockNumber: tx.blockNumber,
      blockTime: tx.blockTime,
      now,
    })

    if (result.ok) {
      await record(db, tx, 'paid', result.orderId, now)
      summary.paid += 1
      log(`shop order ${result.orderId} paid with ${result.item} hash=${tx.hash} block=${tx.blockNumber}`)
      continue
    }

    await record(db, tx, OUTCOMES[result.reason], result.orderId ?? null, now)
    summary.skipped += 1
    log(`skipped hash=${tx.hash} block=${tx.blockNumber}: ${result.reason}`)
  }

  if (furthest > summary.cursor) {
    await db
      .update(watchCursor)
      .set({ lastBlockNumber: furthest, updatedAt: now })
      .where(eq(watchCursor.address, address))

    summary.cursor = furthest
  }

  return summary
}

export type RunWatcherOptions = WatchOptions & { intervalMs?: number; signal?: AbortSignal }

/** Watches the treasury address until the process is stopped. One node failure is a log line. */
export async function runWatcher(db: Db, rpc: WatcherRpc, options: RunWatcherOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 3000
  const log = options.log ?? ((line: string) => console.log(line))

  while (!options.signal?.aborted) {
    try {
      const summary = await tick(db, rpc, { ...options, log, now: new Date() })
      if (summary.paid + summary.expired > 0) {
        log(`watcher paid ${summary.paid} order(s), expired ${summary.expired}, at block ${summary.cursor}`)
      }
    } catch (error) {
      log(`watcher pass failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    await sleep(intervalMs)
  }
}
