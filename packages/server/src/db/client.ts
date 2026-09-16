import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config, serverRoot } from '../config.js'
import * as schema from './schema.js'

const defaultDataDir = resolve(serverRoot, '.data/vettai')

export { serverRoot }

/**
 * Both drivers build the same SQL and expose the same query builder; they differ only
 * in the raw row type of db.execute(), which nothing outside this file uses. Presenting
 * one type keeps every query in the server written once.
 */
export type Db = PgliteDatabase<typeof schema>

export type DbHandle = {
  db: Db
  kind: 'pglite' | 'postgres'
  close: () => Promise<void>
}

/**
 * The one way the world and the treasury open the database. A Postgres URL, from the
 * argument or from the environment, wins; without one the server runs on PGlite under
 * .data/vettai, which is what local runs and tests use.
 */
export async function openDb(url?: string): Promise<DbHandle> {
  const target = url ?? config.DATABASE_URL

  if (target && !target.startsWith('memory://')) {
    const sql = postgres(target, { max: 4, onnotice: () => {} })
    return {
      db: drizzlePostgres(sql, { schema }) as unknown as Db,
      kind: 'postgres',
      close: async () => {
        await sql.end({ timeout: 5 })
      },
    }
  }

  const dataDir = target ?? defaultDataDir
  // PGlite opens the folder but does not create the path above it.
  if (!dataDir.startsWith('memory://')) mkdirSync(dataDir, { recursive: true })

  const client = new PGlite(dataDir)
  await client.waitReady

  return {
    db: drizzlePglite(client, { schema }),
    kind: 'pglite',
    close: () => client.close(),
  }
}

/** A fresh empty database that lives only in memory. Used by the tests. */
export function openMemoryDb(): Promise<DbHandle> {
  return openDb('memory://')
}
