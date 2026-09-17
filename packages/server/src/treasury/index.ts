import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, poolTotalLuna } from '../config.js'
import { openDb, type Db, type DbHandle } from '../db/client.js'
import { applyMigrations } from '../db/migrate.js'
import { claimTotals, releaseHeld } from '../domain/claims.js'
import { payDueLadders } from '../domain/ladder.js'
import { lunaToNim } from '../lib/luna.js'
import { sleep } from '../lib/sleep.js'
import {
  getAccountByAddress,
  getBlockNumber,
  getNetworkName,
  getStakerByAddress,
  fetchTransaction,
  listIncoming,
  listOutgoing,
  mempoolHas,
  pushTransaction,
} from '../nimiq/rpc.js'
import { createStatus, startHealthListener } from './health.js'
import { runOutbox } from './outbox.js'
import { waitForTreasuryConfig } from './refuse.js'
import { createSender } from './sender.js'
import { completeLandlordQuests, shouldReadStakes } from './stakes.js'
import { runWatcher } from './watcher.js'

const OUTBOX_MS = 2000
const WATCHER_MS = 3000
const STAKES_CHECK_MS = 10 * 60 * 1000
const RELEASE_MS = 60 * 1000
const LADDER_CHECK_MS = 10 * 60 * 1000

const liveRpc = {
  getAccountByAddress,
  getBlockNumber,
  getNetworkName,
  getStakerByAddress,
  fetchTransaction,
  listIncoming,
  listOutgoing,
  mempoolHas,
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
 * Refuses to start when the wallet cannot cover what the pool still promises.
 *
 * The pool is a promise to players, so the wallet behind it has to hold everything that has
 * not been paid out yet. Finding that out at boot is the difference between a deployment
 * that never starts and a game that plays for a week and then cannot pay the person who won
 * it. Both numbers are printed either way, because "it is short" is useless without them.
 */
export async function assertWalletCoversPool(
  db: Db,
  balanceLuna: bigint,
  say: (line: string) => void = log,
): Promise<void> {
  const totals = await claimTotals(db)
  const owed = poolTotalLuna - totals.paidLuna

  say(`wallet holds ${lunaToNim(balanceLuna)} NIM, the pool still owes ${lunaToNim(owed > 0n ? owed : 0n)} NIM`)

  if (owed > 0n && balanceLuna < owed) {
    throw new Error(
      `the treasury wallet holds ${lunaToNim(balanceLuna)} NIM and the pool still promises ` +
        `${lunaToNim(owed)} NIM. Top the wallet up, or lower POOL_TOTAL_NIM to what it can pay`,
    )
  }
}

/**
 * The treasury process: it holds the key, pays what the world has queued, watches for shop
 * payments, and answers a health page the host can probe.
 *
 * The order here is deliberate. The health listener comes up first, so a treasury that
 * cannot reach its node is still a process the host can see and ask. Then the two questions
 * that decide whether it may spend at all, asked until the node answers them. Only then the
 * database, the wallet balance against what is owed, and the loops.
 */
export async function runTreasury(): Promise<void> {
  if (!config.TREASURY_PRIVATE_KEY) {
    throw new Error('the treasury process needs TREASURY_PRIVATE_KEY and it is not set')
  }

  const stopping = new AbortController()
  const stop = (): void => stopping.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  const status = createStatus(config.NIMIQ_NETWORK, config.TREASURY_ADDRESS)
  const health = await startHealthListener({ status, port: config.TREASURY_PORT, log })

  let handle: DbHandle | null = null

  try {
    const identity = await waitForTreasuryConfig(
      {
        privateKeyHex: config.TREASURY_PRIVATE_KEY,
        expectedAddress: config.TREASURY_ADDRESS,
        network: config.NIMIQ_NETWORK,
        rpc: liveRpc,
      },
      { log, signal: stopping.signal },
    )

    status.nodeOk = true

    handle = await openDb()
    const migrations = await applyMigrations(handle)
    for (const name of migrations.applied) log(`applied migration ${name}`)

    const db = handle.db
    status.db = db

    const sender = createSender({
      privateKeyHex: config.TREASURY_PRIVATE_KEY,
      network: config.NIMIQ_NETWORK,
      rpc: liveRpc,
    })

    const balanceLuna = await sender.balanceLuna()
    status.balanceLuna = balanceLuna
    await assertWalletCoversPool(db, balanceLuna)

    // The stake read is due once per UTC day, so the day it last ran is what the gate is
    // measured against. Null means it has not run in this process, which is why a restart
    // reads the stakes once on the way up.
    let lastStakeDay: string | null = null

    log(`vettai treasury ready address=${identity.address} network=${identity.network} database=${handle.kind}`)

    await Promise.all([
      runOutbox(db, sender, {
        intervalMs: OUTBOX_MS,
        log,
        signal: stopping.signal,
        onPass: (pass) => {
          status.lastOutboxPassAt = pass.at
          status.nodeOk = pass.nodeOk
          if (pass.balanceLuna !== null) status.balanceLuna = pass.balanceLuna
          if (pass.committedLuna !== null) status.committedLuna = pass.committedLuna
        },
      }),
      runWatcher(db, liveRpc, {
        intervalMs: WATCHER_MS,
        log,
        signal: stopping.signal,
        onPass: (pass) => {
          status.lastWatcherPassAt = pass.at
        },
      }),
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
      every('the ladder', LADDER_CHECK_MS, stopping.signal, async () => {
        const caught = await payDueLadders(db, new Date(), config.LADDER_FLOOR_WEEK)
        for (const week of caught.paid) log(`ladder ${week} paid`)
      }),
    ])

    log('vettai treasury stopped')
  } finally {
    await health.close()
    await handle?.close()
  }
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  await runTreasury()
  process.exit(0)
}
