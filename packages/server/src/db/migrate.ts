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

/** Brings a database up to the latest schema and says which files it ran. */
export async function applyMigrations(handle: DbHandle): Promise<MigrationReport> {
  const names = await migrationNames()
  const before = await alreadyRun(handle)

  if (handle.kind === 'pglite') {
    await migratePglite(handle.db, { migrationsFolder })
  } else {
    await migratePostgres(handle.db as unknown as Parameters<typeof migratePostgres>[0], { migrationsFolder })
  }

  return {
    alreadyApplied: names.slice(0, before),
    applied: names.slice(before),
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
