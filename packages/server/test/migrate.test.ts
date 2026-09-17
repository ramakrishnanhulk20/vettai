// Covers the order the migrator does its work in on Postgres: take the lock, look, migrate,
// let go. It does NOT run a real migration against a real Postgres (the other test files
// do that through PGlite), and it does NOT prove two processes actually queue on the lock,
// which only a live server can show.

import { describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '../src/db/client.js'

const migratePostgres = vi.fn(async () => {})
const migratePglite = vi.fn(async () => {})

vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: migratePostgres }))
vi.mock('drizzle-orm/pglite/migrator', () => ({ migrate: migratePglite }))

const { applyMigrations, MIGRATION_LOCK } = await import('../src/db/migrate.js')

type Statement = { queryChunks?: { value?: string[] }[] }

/** The text of a drizzle statement, which is all these tests need to read. */
function textOf(query: unknown): string {
  const chunks = (query as Statement).queryChunks ?? []
  return chunks.map((chunk) => (chunk.value ?? []).join('')).join('')
}

/** A database that writes down what it was asked to run and answers the count with zero. */
function spyHandle(kind: DbHandle['kind']): { handle: DbHandle; statements: string[] } {
  const statements: string[] = []
  const db = {
    execute: async (query: unknown) => {
      statements.push(textOf(query))
      return { rows: [{ count: 0 }] }
    },
  }

  return {
    statements,
    handle: { db: db as unknown as DbHandle['db'], kind, close: async () => {} },
  }
}

describe('applyMigrations on Postgres', () => {
  it('takes the advisory lock, migrates, and lets it go again', async () => {
    migratePostgres.mockClear()
    const { handle, statements } = spyHandle('postgres')

    const report = await applyMigrations(handle)

    expect(statements[0]).toBe(`select pg_advisory_lock(${MIGRATION_LOCK})`)
    expect(statements[statements.length - 1]).toBe(`select pg_advisory_unlock(${MIGRATION_LOCK})`)
    expect(migratePostgres).toHaveBeenCalledTimes(1)
    expect(report.applied.length).toBeGreaterThan(0)
  })

  it('lets the lock go even when the migration falls over', async () => {
    const { handle, statements } = spyHandle('postgres')
    migratePostgres.mockClear()
    migratePostgres.mockRejectedValueOnce(new Error('the migration fell over'))

    await expect(applyMigrations(handle)).rejects.toThrow('the migration fell over')

    expect(statements.at(-1)).toBe(`select pg_advisory_unlock(${MIGRATION_LOCK})`)
  })
})

describe('applyMigrations on PGlite', () => {
  it('runs without a lock, because one process owns the file', async () => {
    migratePglite.mockClear()
    const { handle, statements } = spyHandle('pglite')

    await applyMigrations(handle)

    expect(statements.some((line) => line.includes('advisory'))).toBe(false)
    expect(migratePglite).toHaveBeenCalledTimes(1)
  })
})
