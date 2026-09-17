import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { config, dailyCapLuna } from '../config.js'
import type { Db } from '../db/client.js'
import { quests, type Quest } from '../db/schema.js'
import { DAY_MS, utcDay } from '../lib/day.js'
import { lunaToNim } from '../lib/luna.js'
import { seeded } from '../world/prng.js'
import type { WorldMap } from '../world/types.js'
import { committedToday, type Tx } from './claims.js'
import { clampToAllowance, rewards, streakReward } from './rewards.js'

/**
 * The day's work, and the only thing that turns play into money later.
 *
 * Every number here is written by the server from events the server itself produced. The
 * client never reports a kill, a delivery or a visit; it sends an intent, the simulation
 * decides what happened, and this file writes it down.
 */

/** Kills keep counting past the hunt target so the weekly ladder can read real play. */
export const HUNT_TARGET = 5
export const HUNT_PROGRESS_CAP = 999

export const LANDMARK_COUNT = 4

/** One parcel delivered finishes the courier quest. */
export const COURIER_TARGET = 1

/** A parcel goes cold two minutes after it is picked up. */
export const COURIER_WINDOW_MS = 120_000

export type QuestKind = 'hunt' | 'courier' | 'landmarks' | 'landlord' | 'streak'

/** What the world tells the quest engine. Each one is produced by the server, never sent in. */
export type QuestEvent =
  | { kind: 'kill' }
  | { kind: 'pickup'; point: number }
  | { kind: 'deliver'; point: number }
  | { kind: 'landmark'; index: number }

/** The same event once the room has said whose it is. */
export type PlayerQuestEvent = QuestEvent & { address: string }

export type QuestView = {
  id: string
  kind: QuestKind
  day: string
  target: number
  progress: number
  state: 'open' | 'done' | 'claimed'
  rewardLuna: string
  rewardNim: string
  /** Where to pick the parcel up and where to drop it, on a courier quest. */
  route?: { from: number; to: number }
  /** Which of the four landmarks have been reached, on a landmarks quest. */
  visited?: boolean[]
  /** True while the player is carrying a parcel. */
  carrying?: boolean
}

function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
}

/** A courier quest's own notes: the two points, and the second the parcel was picked up. */
export type CourierDetail = { from: number; to: number; pickedUpAt: number | null }

function detailObject(quest: Quest): Record<string, unknown> {
  const detail = quest.detail
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return {}
  return detail as Record<string, unknown>
}

/**
 * The courier quest's route and clock, or null on a row that has no route written down.
 * The column is free-form JSON, so every field is checked rather than trusted.
 */
export function courierDetail(quest: Quest): CourierDetail | null {
  const detail = detailObject(quest)
  const from = detail['from']
  const to = detail['to']
  if (typeof from !== 'number' || typeof to !== 'number') return null

  const pickedUpAt = detail['pickedUpAt']
  return { from, to, pickedUpAt: typeof pickedUpAt === 'number' ? pickedUpAt : null }
}

/** Which landmarks this quest has already counted, in the order they were reached. */
export function visitedLandmarks(quest: Quest): number[] {
  const visited = detailObject(quest)['visited']
  if (!Array.isArray(visited)) return []

  return visited.filter(
    (index: unknown): index is number =>
      typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < LANDMARK_COUNT,
  )
}

/** The quest as the phone sees it, with the detail column read back into plain fields. */
export function questView(quest: Quest): QuestView {
  const kind = quest.kind as QuestKind
  const base = {
    id: quest.id,
    kind,
    day: quest.day,
    target: quest.target,
    progress: quest.progress,
    state: quest.state as 'open' | 'done' | 'claimed',
    rewardLuna: String(quest.rewardLuna),
    rewardNim: lunaToNim(quest.rewardLuna),
  }

  if (kind === 'courier') {
    const detail = courierDetail(quest)
    return {
      ...base,
      ...(detail ? { route: { from: detail.from, to: detail.to } } : {}),
      carrying: quest.state === 'open' && detail?.pickedUpAt != null,
    }
  }

  if (kind === 'landmarks') {
    const reached = visitedLandmarks(quest)
    const visited: boolean[] = []
    for (let index = 0; index < LANDMARK_COUNT; index += 1) visited.push(reached.includes(index))
    return { ...base, visited }
  }

  return base
}

/**
 * Reads and writes that run either on the database or inside a transaction the caller
 * already owns. The day's set is created from both doors: a socket opening, and a write
 * from the world that lands on a day nobody has opened yet.
 */
type Store = Db | Tx

function readDay(db: Store, address: string, day: string): Promise<Quest[]> {
  return (db as Db)
    .select()
    .from(quests)
    .where(and(eq(quests.address, address), eq(quests.day, day)))
    .orderBy(quests.kind)
}

/** True when this wallet already has a quest set for that UTC day. */
export async function hasQuestsForDay(db: Store, address: string, day: string): Promise<boolean> {
  const [row] = await (db as Db)
    .select({ id: quests.id })
    .from(quests)
    .where(and(eq(quests.address, address), eq(quests.day, day)))
    .limit(1)

  return row !== undefined
}

/** A pickup point and a different drop point, drawn from the wallet and the day, not a clock. */
function pickRoute(address: string, day: string, points: number): { from: number; to: number } {
  const rng = seeded(`${address}:${day}:courier`)
  const from = Math.floor(rng() * points)
  const to = (from + 1 + Math.floor(rng() * (points - 1))) % points
  return { from, to }
}

async function seenLandmarksBefore(db: Store, address: string, day: string): Promise<boolean> {
  const [row] = await (db as Db)
    .select({ id: quests.id })
    .from(quests)
    .where(and(eq(quests.address, address), eq(quests.kind, 'landmarks'), lt(quests.day, day)))
    .limit(1)

  return row !== undefined
}

/**
 * Which day of the streak today is: the run of UTC days directly before today on which this
 * wallet had a streak quest standing, plus today. Done counts as well as claimed, because a
 * day whose reward the daily cap cut to nothing cannot be claimed at all, and a cap is meant
 * to delay money rather than to destroy a run the player turned up for. A day the player
 * never played has no row, and that still ends the run.
 */
export async function streakDay(db: Store, address: string, day: string): Promise<number> {
  const rows = await (db as Db)
    .select({ day: quests.day })
    .from(quests)
    .where(
      and(
        eq(quests.address, address),
        eq(quests.kind, 'streak'),
        inArray(quests.state, ['done', 'claimed']),
        lt(quests.day, day),
      ),
    )
    .orderBy(desc(quests.day))
    .limit(400)

  let expected = dayBefore(day)
  let run = 0
  for (const row of rows) {
    if (row.day !== expected) break
    run += 1
    expected = dayBefore(expected)
  }

  return run + 1
}

/**
 * The day's quests, created once and read back every time after that.
 *
 * The insert leans on the table's unique (address, day, kind) line rather than on a check
 * before it, so two sockets opening at the same second cannot both create today's hunt.
 * The streak quest is born done: turning up is the whole task, and the player still has to
 * sign for it before it pays.
 *
 * The streak is written down at what the wallet's daily cap still allows rather than at the
 * full curve, so the number on the screen is the number that would actually be paid. A
 * wallet that has already had its day gets a streak worth nothing, marked as clamped.
 */
export async function todaysQuests(
  db: Store,
  address: string,
  map: WorldMap,
  now: Date = new Date(),
): Promise<Quest[]> {
  const day = utcDay(now)

  const existing = await readDay(db, address, day)
  if (existing.length > 0) return existing

  const route = pickRoute(address, day, map.courier.length)
  const repeatLandmarks = await seenLandmarksBefore(db, address, day)
  const streak = await streakDay(db, address, day)

  const earned = streakReward(streak)
  const streakLuna = clampToAllowance(earned, await committedToday(db, address, now), dailyCapLuna)

  const rows: (typeof quests.$inferInsert)[] = [
    { address, day, kind: 'hunt', target: HUNT_TARGET, rewardLuna: rewards.hunt },
    {
      address,
      day,
      kind: 'courier',
      target: COURIER_TARGET,
      rewardLuna: rewards.courier,
      detail: { from: route.from, to: route.to, pickedUpAt: null },
    },
    {
      address,
      day,
      kind: 'landmarks',
      target: LANDMARK_COUNT,
      rewardLuna: repeatLandmarks ? rewards.landmarksRepeat : rewards.landmarksFirst,
      detail: { visited: [] },
    },
    {
      address,
      day,
      kind: 'streak',
      target: 1,
      progress: 1,
      state: 'done',
      doneAt: now,
      rewardLuna: streakLuna,
      ...(streakLuna < earned ? { detail: { clamped: true } } : {}),
    },
  ]

  if (config.LANDLORD_ENABLED) {
    rows.push({ address, day, kind: 'landlord', target: 1, rewardLuna: rewards.landlord })
  }

  await (db as Db).insert(quests).values(rows).onConflictDoNothing()

  return readDay(db, address, day)
}

/**
 * The row, locked for the rest of the transaction. Two kills landing in the same
 * millisecond would otherwise both read progress 4 and both write 5.
 */
async function lockQuest(
  tx: Tx,
  address: string,
  day: string,
  kind: QuestKind,
): Promise<Quest | undefined> {
  const [row] = await tx
    .select()
    .from(quests)
    .where(and(eq(quests.address, address), eq(quests.day, day), eq(quests.kind, kind)))
    .limit(1)
    .for('update')

  return row
}

/**
 * The same row with no lock on it, for deciding whether an event is worth a lock at all.
 * A flood of useless interacts would otherwise queue up behind FOR UPDATE and hold the
 * batch open for everybody else in the room.
 */
async function peekQuest(
  tx: Tx,
  address: string,
  day: string,
  kind: QuestKind,
): Promise<Quest | undefined> {
  const [row] = await tx
    .select()
    .from(quests)
    .where(and(eq(quests.address, address), eq(quests.day, day), eq(quests.kind, kind)))
    .limit(1)

  return row
}

/** Which quest an event belongs to. */
function questFor(event: QuestEvent): QuestKind {
  if (event.kind === 'kill') return 'hunt'
  if (event.kind === 'landmark') return 'landmarks'
  return 'courier'
}

/**
 * True when this event could still change this row. The pre-read and the locked read are
 * both judged by it, so the cheap look and the real one can never disagree about what
 * counts: the lock only settles who gets there first.
 */
function canChange(quest: Quest | undefined, event: QuestEvent): boolean {
  if (!quest) return false

  if (event.kind === 'kill') return quest.progress < HUNT_PROGRESS_CAP
  if (quest.state !== 'open') return false

  if (event.kind === 'pickup' || event.kind === 'deliver') {
    const detail = courierDetail(quest)
    if (!detail) return false
    if (event.kind === 'pickup') return event.point === detail.from
    return event.point === detail.to && detail.pickedUpAt !== null
  }

  if (!Number.isInteger(event.index) || event.index < 0 || event.index >= LANDMARK_COUNT) {
    return false
  }
  return !visitedLandmarks(quest).includes(event.index)
}

function markDone(now: Date): { state: 'done'; doneAt: Date } {
  return { state: 'done', doneAt: now }
}

type QuestUpdate = Partial<typeof quests.$inferInsert>

async function save(tx: Tx, id: string, values: QuestUpdate): Promise<Quest[]> {
  const [row] = await tx.update(quests).set(values).where(eq(quests.id, id)).returning()
  return row ? [row] : []
}

/** What one event did: the rows it changed, and the day's set if it had to be created. */
type Applied = { rows: Quest[]; rolled: Quest[] | null }

/**
 * Moves one quest along inside a transaction the caller already owns, and answers with the
 * rows that actually changed so the room can push them to that player alone.
 *
 * A quest that is already done or claimed is left alone, with one exception: the hunt keeps
 * counting kills after its fifth, because the weekly ladder is read off that number.
 *
 * A player who was already in the world when the UTC day turned writes into a day nobody
 * has opened yet. With a map in hand this creates that day's set first and then applies the
 * event to it, so midnight costs nobody the kill they were in the middle of.
 */
async function applyEventIn(
  tx: Tx,
  address: string,
  event: QuestEvent,
  now: Date,
  map?: WorldMap,
): Promise<Applied> {
  const day = utcDay(now)
  const kind = questFor(event)

  let rolled: Quest[] | null = null
  let seen = await peekQuest(tx, address, day, kind)
  if (!seen && map && !(await hasQuestsForDay(tx, address, day))) {
    rolled = await todaysQuests(tx, address, map, now)
    seen = await peekQuest(tx, address, day, kind)
  }

  if (!canChange(seen, event)) return { rows: [], rolled }

  const quest = await lockQuest(tx, address, day, kind)
  if (!quest || !canChange(quest, event)) return { rows: [], rolled }

  if (event.kind === 'kill') {
    const progress = quest.progress + 1
    const finishes = quest.state === 'open' && progress >= quest.target
    const rows = await save(tx, quest.id, { progress, ...(finishes ? markDone(now) : {}) })
    return { rows, rolled }
  }

  if (event.kind === 'pickup') {
    const detail = courierDetail(quest)
    if (!detail) return { rows: [], rolled }

    const rows = await save(tx, quest.id, {
      detail: { ...detail, pickedUpAt: Math.floor(now.getTime() / 1000) },
    })
    return { rows, rolled }
  }

  if (event.kind === 'deliver') {
    const detail = courierDetail(quest)
    if (!detail || detail.pickedUpAt === null) return { rows: [], rolled }

    const carriedFor = now.getTime() - detail.pickedUpAt * 1000
    if (carriedFor > COURIER_WINDOW_MS) {
      // The parcel went cold on the way. The player keeps the quest and starts again from
      // the pickup point rather than being handed a failure they cannot undo. The row comes
      // back open with nothing in hand, which is what the room reads to say so.
      const rows = await save(tx, quest.id, { detail: { ...detail, pickedUpAt: null } })
      return { rows, rolled }
    }

    const rows = await save(tx, quest.id, { progress: COURIER_TARGET, ...markDone(now) })
    return { rows, rolled }
  }

  const reached = [...visitedLandmarks(quest), event.index]
  const finishes = reached.length >= quest.target
  const rows = await save(tx, quest.id, {
    progress: reached.length,
    detail: { visited: reached },
    ...(finishes ? markDone(now) : {}),
  })
  return { rows, rolled }
}

/** One event from the world, written down on its own. */
export async function applySimEvent(
  db: Db,
  address: string,
  event: QuestEvent,
  now: Date = new Date(),
  map?: WorldMap,
): Promise<Quest[]> {
  const applied = await db.transaction((tx) => applyEventIn(tx, address, event, now, map))
  return applied.rows
}

function withoutAddress(event: PlayerQuestEvent): QuestEvent {
  if (event.kind === 'kill') return { kind: 'kill' }
  if (event.kind === 'landmark') return { kind: 'landmark', index: event.index }
  return { kind: event.kind, point: event.point }
}

export type QuestChange = {
  address: string
  /** The rows this batch changed, which are the ones the player's socket is sent. */
  quests: Quest[]
  /**
   * The whole day's set when the UTC day turned under a player who was still online, so
   * the room can throw away yesterday's copy rather than judging today's walk against it.
   */
  rolled?: Quest[]
}

/**
 * One tick's worth of events from the world, written down in the order they happened.
 *
 * The whole batch is one transaction, so a pickup and the delivery that follows it in the
 * same tick land in that order and the database never shows a half written tick. An event
 * that fails takes the batch down with it and the error goes back to the caller, which
 * logs it, rather than leaving some of the tick saved and some of it lost.
 *
 * The map is what lets a write create the day it belongs to. Without one an event for a day
 * that has no rows is dropped, which is what a caller replaying a day that is over wants.
 */
export async function applyWorldEvents(
  db: Db,
  events: readonly PlayerQuestEvent[],
  now: Date = new Date(),
  map?: WorldMap,
): Promise<QuestChange[]> {
  return db.transaction(async (tx) => {
    const changed = new Map<string, Quest[]>()
    const rolled = new Set<string>()

    for (const event of events) {
      const applied = await applyEventIn(tx, event.address, withoutAddress(event), now, map)
      if (applied.rolled) rolled.add(event.address)
      if (applied.rows.length === 0) continue

      const already = changed.get(event.address) ?? []
      changed.set(event.address, [...already, ...applied.rows])
    }

    const day = utcDay(now)
    const changes: QuestChange[] = []
    for (const address of new Set([...changed.keys(), ...rolled])) {
      changes.push({
        address,
        quests: changed.get(address) ?? [],
        ...(rolled.has(address) ? { rolled: await readDay(tx, address, day) } : {}),
      })
    }

    return changes
  })
}
