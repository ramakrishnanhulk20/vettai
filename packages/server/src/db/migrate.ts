import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import { openDb, serverRoot, type DbHandle } from './client.js'

export const migrationsFolder = resolve(serverRoot, 'drizzle')

type Journal = { entries: { idx: number; tag: string }[] }

export type MigrationReport = {
  applied: string[]
  alreadyApplied: string[]
}

async function migrationNames(): Promise<string[]> {
  const journal = JSON.parse(await readFile(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8')) as Journal
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag)
}

/**
 * Drizzle records migrations by hash, not by name, so the only way to report names is
 * to count what was already there and line the rest up against the journal.
 */
async function alreadyRun(handle: DbHandle): Promise<number> {
  try {
    const result: unknown = await handle.db.execute(
      sql`select count(*)::int as count from drizzle."__drizzle_migrations"`,
    )
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
      count?: number | string
    }[]
    return Number(rows[0]?.count ?? 0)
  } catch {
    return 0
  }
}

/**
 * The number two processes agree to queue on while one of them migrates. Postgres advisory
 * locks live in one namespace for the whole database, so it only has to be a number nothing
 * else in this database uses.
 */
export const MIGRATION_LOCK = 7371

/**
 * Brings a database up to the latest schema and says which files it ran.
 *
 * On Postgres the work is wrapped in an advisory lock, because the world and the treasury
 * boot from the same image at the same moment and drizzle's migrator is not safe against
 * itself: both would read an empty journal and both would run the same CREATE TABLE. The
 * second one in waits at the lock and then finds there is nothing left to do. PGlite is one
 * process with one file, so there is nobody to race.
 */
export async function applyMigrations(handle: DbHandle): Promise<MigrationReport> {
  const names = await migrationNames()

  function report(before: number): MigrationReport {
    return { alreadyApplied: names.slice(0, before), applied: names.slice(before) }
  }

  if (handle.kind === 'pglite') {
    const before = await alreadyRun(handle)
    await migratePglite(handle.db, { migrationsFolder })
    return report(before)
  }

  // The lock number is ours, never a caller's, so it goes into the statement as itself.
  await handle.db.execute(sql.raw(`select pg_advisory_lock(${MIGRATION_LOCK})`))
  try {
    const before = await alreadyRun(handle)
    await migratePostgres(handle.db as unknown as Parameters<typeof migratePostgres>[0], { migrationsFolder })
    return report(before)
  } finally {
    await handle.db.execute(sql.raw(`select pg_advisory_unlock(${MIGRATION_LOCK})`))
  }
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  const handle = await openDb()
  try {
    const report = await applyMigrations(handle)
    console.log(`database: ${handle.kind}`)
    for (const name of report.alreadyApplied) console.log(`already applied  ${name}`)
    for (const name of report.applied) console.log(`applied          ${name}`)
    if (report.applied.length === 0) console.log('schema is up to date')
  } finally {
    await handle.close()
  }
}
