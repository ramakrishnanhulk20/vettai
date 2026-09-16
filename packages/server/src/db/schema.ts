import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Money is a whole number of luna in a bigint, in the database and in JavaScript. NIM
 * strings exist only at the edges, in configuration and on screen.
 */
const luna = (name: string) => bigint(name, { mode: 'bigint' })

/** Addresses are always stored uppercase with no spaces, see src/lib/address.ts. */
const address = (name: string) => text(name)

/** What a player carries. Everything here is bought in the shop except the starting kit. */
export type Gear = { blaster: 'mk1' | 'mk2'; skin: string; sprint: boolean }

export const STARTING_GEAR: Gear = { blaster: 'mk1', skin: 'default', sprint: false }

export const players = pgTable('players', {
  address: address('address').primaryKey(),
  publicKey: text('public_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastIpHash: text('last_ip_hash'),
  gear: jsonb('gear').$type<Gear>().notNull().default(STARTING_GEAR),
  landlordSince: timestamp('landlord_since', { withTimezone: true }),
})

export const sessions = pgTable(
  'sessions',
  {
    // The token itself never reaches the database, only its sha256. A stolen dump
    // cannot be replayed as a login.
    tokenHash: text('token_hash').primaryKey(),
    address: address('address')
      .notNull()
      .references(() => players.address),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('sessions_address_idx').on(table.address)],
)

export const challenges = pgTable(
  'challenges',
  {
    nonce: text('nonce').primaryKey(),
    kind: text('kind').notNull(),
    /** What the nonce is tied to: a quest id, an order id, or null for a login. */
    subject: text('subject'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [check('challenges_kind', sql`${table.kind} in ('login', 'claim', 'shop')`)],
)

export const quests = pgTable(
  'quests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    address: address('address')
      .notNull()
      .references(() => players.address),
    /** The UTC day the quest belongs to, as YYYY-MM-DD. */
    day: date('day', { mode: 'string' }).notNull(),
    kind: text('kind').notNull(),
    target: integer('target').notNull(),
    progress: integer('progress').notNull().default(0),
    state: text('state').notNull().default('open'),
    rewardLuna: luna('reward_luna').notNull(),
    /** Whatever a quest kind needs to describe itself, such as the pickup and drop of a courier run. */
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (table) => [
    // One of each quest per player per day. The database holds this line so two
    // requests arriving together cannot both create today's hunt.
    unique('quests_one_per_player_per_day').on(table.address, table.day, table.kind),
    index('quests_address_day_idx').on(table.address, table.day),
    check('quests_kind', sql`${table.kind} in ('hunt', 'courier', 'landmarks', 'landlord', 'streak')`),
    check('quests_state', sql`${table.state} in ('open', 'done', 'claimed')`),
    check('quests_target', sql`${table.target} > 0`),
    check('quests_progress', sql`${table.progress} >= 0`),
    check('quests_reward_luna', sql`${table.rewardLuna} >= 0`),
  ],
)

export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    address: address('address')
      .notNull()
      .references(() => players.address),
    /** Null for a ladder prize, which is won by a week of play rather than by one quest. */
    questId: uuid('quest_id').references(() => quests.id),
    kind: text('kind').notNull(),
    amountLuna: luna('amount_luna').notNull(),
    state: text('state').notNull().default('queued'),
    memo: text('memo').notNull(),
    txHash: text('tx_hash').unique(),
    blockNumber: integer('block_number'),
    ipHash: text('ip_hash'),
    /** How many times this payout has been rebuilt from scratch. Three is the end of the road. */
    attempts: integer('attempts').notNull().default(0),
    /**
     * When a held payout is worth looking at again. A cap is a delay, so a claim the daily
     * or the IP cap stopped waits for the next UTC midnight rather than being forfeited.
     * Null means "look again on the next pass", which is what a pool hold wants.
     */
    heldUntil: timestamp('held_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    error: text('error'),
  },
  (table) => [
    // A quest pays once. Ladder prizes carry no quest id, so they are left out rather
    // than colliding with each other on null.
    uniqueIndex('claims_one_per_quest').on(table.questId).where(sql`quest_id is not null`),
    index('claims_state_created_idx').on(table.state, table.createdAt),
    index('claims_address_created_idx').on(table.address, table.createdAt),
    check('claims_kind', sql`${table.kind} in ('hunt', 'courier', 'landmarks', 'landlord', 'streak', 'ladder')`),
    check(
      'claims_state',
      sql`${table.state} in ('queued', 'sending', 'sent', 'paid', 'failed', 'held')`,
    ),
    check('claims_amount_luna', sql`${table.amountLuna} > 0`),
    check('claims_attempts', sql`${table.attempts} >= 0`),
    // Nimiq carries at most 64 bytes of memo in a basic transaction.
    check('claims_memo_len', sql`octet_length(${table.memo}) between 1 and 64`),
  ],
)

export const shopOrders = pgTable(
  'shop_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    address: address('address')
      .notNull()
      .references(() => players.address),
    item: text('item').notNull(),
    priceLuna: luna('price_luna').notNull(),
    // The memo is how a payment on chain is matched back to an order, so two open
    // orders sharing one would hand the gear to whoever paid last.
    memo: text('memo').notNull().unique(),
    state: text('state').notNull().default('pending'),
    txHash: text('tx_hash').unique(),
    /** The block the payment was mined in, so a paid order can be checked against the chain. */
    blockNumber: bigint('block_number', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** When the purchase was told to the world, so it is announced once and not on every restart. */
    announcedAt: timestamp('announced_at', { withTimezone: true }),
  },
  (table) => [
    index('shop_orders_address_idx').on(table.address),
    check('shop_orders_state', sql`${table.state} in ('pending', 'paid', 'expired')`),
    check('shop_orders_price_luna', sql`${table.priceLuna} > 0`),
    check('shop_orders_memo_len', sql`octet_length(${table.memo}) between 1 and 64`),
  ],
)

/**
 * Every payment into the treasury the watcher has looked at, and what Vettai decided
 * about it. A refused payment is money that really arrived, so the reason it was not
 * turned into gear has to survive for Ram to settle by hand. The hash is the key, which
 * is what makes reading the same transaction twice a no-op.
 */
export const receivedPayments = pgTable(
  'received_payments',
  {
    txHash: text('tx_hash').primaryKey(),
    sender: address('sender').notNull(),
    recipient: address('recipient').notNull(),
    valueLuna: luna('value_luna').notNull(),
    memo: text('memo'),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }),
    // No foreign key on purpose: this is the record of money that arrived, and it has to
    // outlive the order it names.
    orderId: uuid('order_id'),
    outcome: text('outcome').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('received_payments_order_idx').on(table.orderId),
    check(
      'received_payments_outcome',
      sql`${table.outcome} in ('paid', 'short', 'expired', 'unknown_memo', 'sender_mismatch', 'already_paid')`,
    ),
    check('received_payments_value_luna', sql`${table.valueLuna} >= 0`),
  ],
)

export const ladderPeriods = pgTable('ladder_periods', {
  /** ISO week, written 2026-W41. */
  period: text('period').primaryKey(),
  paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
  claimIds: jsonb('claim_ids').$type<string[]>().notNull(),
})

export const statsDaily = pgTable(
  'stats_daily',
  {
    day: date('day', { mode: 'string' }).primaryKey(),
    players: integer('players').notNull().default(0),
    kills: integer('kills').notNull().default(0),
    // Written as SQL rather than 0n: drizzle-kit cannot serialise a bigint literal into
    // its snapshot, and the generate step dies on it.
    paidLuna: luna('paid_luna').notNull().default(sql`0`),
  },
  (table) => [
    check('stats_daily_players', sql`${table.players} >= 0`),
    check('stats_daily_kills', sql`${table.kills} >= 0`),
    check('stats_daily_paid_luna', sql`${table.paidLuna} >= 0`),
  ],
)

export const watchCursor = pgTable('watch_cursor', {
  address: address('address').primaryKey(),
  // The block height the watcher has finished with. A hash cannot answer "what is new"
  // on its own: the node pages backwards from a hash, so a hash that fell out of the
  // page window would leave the watcher with nowhere to start.
  lastBlockNumber: bigint('last_block_number', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Player = typeof players.$inferSelect
export type Session = typeof sessions.$inferSelect
export type Challenge = typeof challenges.$inferSelect
export type Quest = typeof quests.$inferSelect
export type Claim = typeof claims.$inferSelect
export type ShopOrder = typeof shopOrders.$inferSelect
export type ReceivedPayment = typeof receivedPayments.$inferSelect
export type LadderPeriod = typeof ladderPeriods.$inferSelect
export type StatsDaily = typeof statsDaily.$inferSelect
export type WatchCursorRow = typeof watchCursor.$inferSelect
