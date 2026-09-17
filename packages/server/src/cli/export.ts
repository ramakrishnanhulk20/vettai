import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../db/client.js'
import { claims, receivedPayments, shopOrders } from '../db/schema.js'

/**
 * Writes the three tables that hold money history to one JSON file.
 *
 * Railway's own backups cover the database; this is the copy that leaves the host, so a
 * deleted project or a wrong click is not the end of the record of who was paid what. It
 * reads and writes nothing else: no keys, no sessions, no player rows.
 *
 * Run it through `railway ssh` against the deployed service, or locally with DATABASE_URL
 * pointing at the same database.
 */

const USAGE = 'npm run treasury:export -- --out <file.json>'

export type ExportArguments = { out: string }

export function parseExportArguments(argv: readonly string[]): ExportArguments {
  let out = ''

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''

    if (token === '--out') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--out needs a path to write to. Usage: ${USAGE}`)
      }
      out = value
      index += 1
      continue
    }

    throw new Error(`"${token}" is not an option this command knows. Usage: ${USAGE}`)
  }

  if (out === '') throw new Error(`--out is required. Usage: ${USAGE}`)
  return { out }
}

export type MoneyExport = {
  takenAt: string
  claims: unknown[]
  shopOrders: unknown[]
  receivedPayments: unknown[]
}

/** Every amount is a bigint in the database, and JSON has no bigint, so they go out as text. */
function asJson(rows: Record<string, unknown>[]): unknown[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'bigint') copy[key] = value.toString()
      else if (value instanceof Date) copy[key] = value.toISOString()
      else copy[key] = value
    }
    return copy
  })
}

export async function readMoneyTables(db: Db, now: Date = new Date()): Promise<MoneyExport> {
  return {
    takenAt: now.toISOString(),
    claims: asJson(await db.select().from(claims)),
    shopOrders: asJson(await db.select().from(shopOrders)),
    receivedPayments: asJson(await db.select().from(receivedPayments)),
  }
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  let args: ExportArguments
  try {
    args = parseExportArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const handle = await openDb()
  try {
    const dump = await readMoneyTables(handle.db)
    const file = resolve(process.cwd(), args.out)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(dump, null, 2)}\n`, 'utf8')
    console.log(
      `wrote ${dump.claims.length} claim(s), ${dump.shopOrders.length} order(s) and ` +
        `${dump.receivedPayments.length} payment(s) to ${file}`,
    )
  } finally {
    await handle.close()
  }
}
