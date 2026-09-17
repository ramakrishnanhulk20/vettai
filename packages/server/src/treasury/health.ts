import { createServer, type Server } from 'node:http'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { claims } from '../db/schema.js'
import { lunaToNim } from '../lib/luna.js'

/**
 * What the treasury knows about itself right now.
 *
 * The treasury has no public domain and no screen, so without this the only way to see
 * whether it is paying anybody is to read the logs or the database. Every field here is
 * written by the loops as they run, never guessed, and the two money numbers come off the
 * chain rather than out of our own books.
 */
export type TreasuryStatus = {
  network: string
  address: string
  balanceLuna: bigint | null
  committedLuna: bigint | null
  lastOutboxPassAt: Date | null
  lastWatcherPassAt: Date | null
  nodeOk: boolean
  db: Db | null
}

export function createStatus(network: string, address: string): TreasuryStatus {
  return {
    network,
    address,
    balanceLuna: null,
    committedLuna: null,
    lastOutboxPassAt: null,
    lastWatcherPassAt: null,
    nodeOk: false,
    db: null,
  }
}

/** How long the oldest payout has been waiting to leave, in seconds. Null when none is. */
export async function oldestQueuedAgeSeconds(db: Db, now: Date): Promise<number | null> {
  const [row] = await db
    .select({ oldest: sql<string | null>`min(${claims.createdAt})` })
    .from(claims)
    .where(sql`${claims.state} in ('queued', 'sending', 'sent')`)

  if (!row?.oldest) return null
  const at = new Date(row.oldest)
  if (Number.isNaN(at.getTime())) return null

  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000))
}

export type HealthBody = {
  ok: boolean
  network: string
  address: string
  balanceNim: string | null
  committedNim: string | null
  lastOutboxPassAt: string | null
  lastWatcherPassAt: string | null
  oldestQueuedAgeSeconds: number | null
  nodeOk: boolean
}

/**
 * The answer to GET /health. It is ok only when the node is answering and the wallet still
 * covers what has been promised, because those are the two ways this process stops being
 * able to pay people while looking perfectly alive.
 */
export async function healthBody(status: TreasuryStatus, now: Date = new Date()): Promise<HealthBody> {
  const queuedAge = status.db ? await oldestQueuedAgeSeconds(status.db, now) : null
  const covered =
    status.balanceLuna !== null &&
    status.committedLuna !== null &&
    status.balanceLuna >= status.committedLuna

  return {
    ok: status.nodeOk && covered,
    network: status.network,
    address: status.address,
    balanceNim: status.balanceLuna === null ? null : lunaToNim(status.balanceLuna),
    committedNim: status.committedLuna === null ? null : lunaToNim(status.committedLuna),
    lastOutboxPassAt: status.lastOutboxPassAt?.toISOString() ?? null,
    lastWatcherPassAt: status.lastWatcherPassAt?.toISOString() ?? null,
    oldestQueuedAgeSeconds: queuedAge,
    nodeOk: status.nodeOk,
  }
}

export type HealthListener = { port: number; close: () => Promise<void> }

/**
 * A listener with one route on it. It never touches money and it is never given a public
 * domain: it exists so the host's health check and Ram can see the treasury without opening
 * a shell. 127.0.0.1 is not enough, because the host probes it from outside the container.
 */
export function startHealthListener(options: {
  status: TreasuryStatus
  port: number
  log?: (line: string) => void
}): Promise<HealthListener> {
  const log = options.log ?? ((line: string) => console.log(line))

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]

    if (request.method !== 'GET' || path !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }

    healthBody(options.status)
      .then((body) => {
        response.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      })
      .catch((error: unknown) => {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'failed' }))
      })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(options.port, '0.0.0.0', () => {
      log(`treasury health on port ${options.port}`)
      resolve({
        port: options.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
