import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { openDb, type Db, type DbHandle } from '../db/client.js'
import { applyMigrations } from '../db/migrate.js'
import { releaseHeld } from '../domain/claims.js'
import { previousWeek, payLadder } from '../domain/ladder.js'
import { sleep } from '../lib/sleep.js'
import {
  getBlockNumber,
  getNetworkName,
  getStakerByAddress,
  fetchTransaction,
  listIncoming,
  pushTransaction,
} from '../nimiq/rpc.js'
import { runOutbox } from './outbox.js'
import { assertTreasuryConfig } from './refuse.js'
import { createSender } from './sender.js'
import { completeLandlordQuests, shouldReadStakes } from './stakes.js'
import { runWatcher } from './watcher.js'

const OUTBOX_MS = 2000
const WATCHER_MS = 3000
const STAKES_CHECK_MS = 10 * 60 * 1000
const RELEASE_MS = 60 * 1000
const LADDER_CHECK_MS = 10 * 60 * 1000

/** The minute past Monday midnight UTC when the week that just closed is paid. */
const LADDER_MINUTE = 5

const liveRpc = {
  getBlockNumber,
  getNetworkName,
  getStakerByAddress,
  fetchTransaction,
  listIncoming,
  pushTransaction,
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`)
}

/** Runs a job now and then every interval, until the process is stopped. A failing run is a log line. */
async function every(name: string, intervalMs: number, signal: AbortSignal, job: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    try {
      await job()
    } catch (error) {
      log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    await sleep(intervalMs, signal)
  }
}

/**
 * Pays the week that has just closed, on a Monday, a few minutes after midnight UTC.
 *
 * The minutes matter less than they look: payLadder writes the period row inside its own
 * transaction, so a second check, a restart, or a clock that drifts cannot pay a week
 * twice. The window is wide enough that a process restarting through midnight still
 * catches it.
 */
async function ladderPass(db: Db, now: Date): Promise<void> {
  const isMonday = now.getUTCDay() === 1
  const pastTheMinute = now.getUTCHours() > 0 || now.getUTCMinutes() >= LADDER_MINUTE
  if (!isMonday || !pastTheMinute) return

  const week = previousWeek(now)
  const result = await payLadder(db, week, now)
  if (result.paid) {
    log(`ladder ${week} paid ${result.claimIds.length} prize(s) to ${result.winners.length} player(s)`)
  }
}

async function main(): Promise<void> {
  if (!config.TREASURY_PRIVATE_KEY) {
    throw new Error('the treasury process needs TREASURY_PRIVATE_KEY and it is not set')
  }

  const identity = await assertTreasuryConfig({
    privateKeyHex: config.TREASURY_PRIVATE_KEY,
    expectedAddress: config.TREASURY_ADDRESS,
    network: config.NIMIQ_NETWORK,
    rpc: liveRpc,
  })

  let handle: DbHandle | null = null

  try {
    handle = await openDb()
    const migrations = await applyMigrations(handle)
    for (const name of migrations.applied) log(`applied migration ${name}`)

    const db = handle.db
    const sender = createSender({
      privateKeyHex: config.TREASURY_PRIVATE_KEY,
      network: config.NIMIQ_NETWORK,
      rpc: liveRpc,
    })

    // The stake read is due once per UTC day, so the day it last ran is what the gate is
    // measured against. Null means it has not run in this process, which is why a restart
    // reads the stakes once on the way up.
    let lastStakeDay: string | null = null

    const stopping = new AbortController()
    const stop = () => stopping.abort()
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    log(`vettai treasury ready address=${identity.address} network=${identity.network} database=${handle.kind}`)

    await Promise.all([
      runOutbox(db, sender, { intervalMs: OUTBOX_MS, log, signal: stopping.signal }),
      runWatcher(db, liveRpc, { intervalMs: WATCHER_MS, log, signal: stopping.signal }),
      every('the stake read', STAKES_CHECK_MS, stopping.signal, async () => {
        const now = new Date()
        if (!shouldReadStakes(lastStakeDay, now)) return

        const summary = await completeLandlordQuests(db, liveRpc, now, { log })
        lastStakeDay = now.toISOString().slice(0, 10)
        if (summary.checked > 0) log(`read ${summary.checked} stake(s), finished ${summary.completed} quest(s)`)
      }),
      every('the held claims', RELEASE_MS, stopping.signal, async () => {
        const summary = await releaseHeld(db, new Date())
        if (summary.released > 0) log(`released ${summary.released} held claim(s) back into the queue`)
      }),
      every('the ladder', LADDER_CHECK_MS, stopping.signal, () => ladderPass(db, new Date())),
    ])

    log('vettai treasury stopped')
  } finally {
    await handle?.close()
  }
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  await main()
  process.exit(0)
}
