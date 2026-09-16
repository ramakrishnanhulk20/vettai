import { randomBytes } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import { openMemoryDb, type Db, type DbHandle } from '../../src/db/client.js'
import { applyMigrations } from '../../src/db/migrate.js'
import {
  challenges,
  claims,
  ladderPeriods,
  players,
  quests,
  receivedPayments,
  sessions,
  shopOrders,
  statsDaily,
  watchCursor,
  type Player,
} from '../../src/db/schema.js'

/** A Postgres that lives only in this test process, with the real migrations applied. */
export async function freshDb(): Promise<DbHandle> {
  const handle = await openMemoryDb()
  await applyMigrations(handle)
  return handle
}

/** Emptied children first, because every table below points back at players. */
export async function clearTables(db: Db): Promise<void> {
  await db.delete(claims)
  await db.delete(quests)
  await db.delete(receivedPayments)
  await db.delete(shopOrders)
  await db.delete(sessions)
  await db.delete(players)
  await db.delete(challenges)
  await db.delete(ladderPeriods)
  await db.delete(statsDaily)
  await db.delete(watchCursor)
}

/** A real Nimiq address, checksum and all, so nothing here passes on a fake one. */
export function randomAddress(): string {
  return KeyPair.generate().toAddress().toUserFriendlyAddress().replace(/\s+/g, '')
}

export function randomHash(): string {
  return randomBytes(32).toString('hex')
}

export async function insertPlayer(db: Db, address: string = randomAddress()): Promise<Player> {
  const [row] = await db
    .insert(players)
    .values({ address, publicKey: randomHash() })
    .returning()

  if (!row) throw new Error('could not insert the test player')
  return row
}
