import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { openDb, type Db } from '../db/client.js'
import { claims, type Claim } from '../db/schema.js'
import { lunaToNim } from '../lib/luna.js'

/**
 * Puts a failed payout back in the queue, or writes it off, one claim at a time.
 *
 * A payout only reaches `failed` when the treasury built it three times and the node never
 * took any of them, which means something about that moment was wrong rather than something
 * about the claim. This is how Ram gives it another go once the node is healthy. The claim
 * is printed first, so the decision is made against what is really in the row.
 *
 * Cancelling is the other half: a claim that is never going to be paid, a test row, a wallet
 * that turned out to be a duplicate. Cancelled money leaves the pool's committed total, and
 * that is the only thing in Vettai that ever frees pool room without paying anybody, so it
 * is a person's decision and never the treasury's.
 */

const USAGE = 'npm run treasury:requeue -- --claim <id> [--cancel]'

/** A claim id is a uuid. Anything else is refused here rather than by the database. */
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RequeueArguments = { claimId: string; cancel: boolean }

export function parseRequeueArguments(argv: readonly string[]): RequeueArguments {
  let claimId = ''
  let cancel = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''

    if (token === '--cancel') {
      cancel = true
      continue
    }

    if (token === '--claim') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--claim needs the id of a claim. Usage: ${USAGE}`)
      }
      claimId = value
      index += 1
      continue
    }

    throw new Error(`"${token}" is not an option this command knows. Usage: ${USAGE}`)
  }

  if (claimId === '') throw new Error(`--claim is required. Usage: ${USAGE}`)
  if (!CLAIM_ID.test(claimId)) throw new Error(`"${claimId}" is not a claim id. Usage: ${USAGE}`)
  return { claimId, cancel }
}

export function describeClaim(claim: Claim): string[] {
  return [
    `claim     ${claim.id}`,
    `wallet    ${claim.address}`,
    `kind      ${claim.kind}`,
    `amount    ${lunaToNim(claim.amountLuna)} NIM`,
    `state     ${claim.state}`,
    `attempts  ${claim.attempts}`,
    `memo      ${claim.memo}`,
    `hash      ${claim.txHash ?? 'none'}`,
    `error     ${claim.error ?? 'none'}`,
  ]
}

export type RequeueRun = {
  db: Db
  args: RequeueArguments
  say: (line: string) => void
  now?: Date
}

/** Returns the exit code: 0 when the claim was moved, 1 for every refusal. */
export async function runRequeue(run: RequeueRun): Promise<number> {
  if (!CLAIM_ID.test(run.args.claimId)) {
    run.say(`"${run.args.claimId}" is not a claim id`)
    return 1
  }

  const [claim] = await run.db.select().from(claims).where(eq(claims.id, run.args.claimId)).limit(1)

  if (!claim) {
    run.say(`there is no claim with id ${run.args.claimId}`)
    return 1
  }

  for (const line of describeClaim(claim)) run.say(line)
  run.say('')

  if (claim.state !== 'failed') {
    run.say(`this claim is ${claim.state}, and only a failed one is moved by hand`)
    return 1
  }

  if (run.args.cancel) {
    await run.db
      .update(claims)
      .set({ state: 'cancelled', error: 'cancelled by hand' })
      .where(eq(claims.id, claim.id))

    run.say(`cancelled. ${lunaToNim(claim.amountLuna)} NIM is back in the pool and nobody is paid it`)
    return 0
  }

  // The hash and the height go with it: whatever was built before was never accepted, and
  // the next attempt has to be a new transaction the chain can still take.
  await run.db
    .update(claims)
    .set({
      state: 'queued',
      txHash: null,
      validityStartHeight: null,
      sentAt: null,
      nextAttemptAt: null,
      attempts: 0,
      error: 'requeued by hand',
    })
    .where(eq(claims.id, claim.id))

  run.say(`queued again. The treasury picks it up on its next pass`)
  return 0
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  let args: RequeueArguments
  try {
    args = parseRequeueArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const handle = await openDb()
  try {
    process.exit(await runRequeue({ db: handle.db, args, say: (line) => console.log(line) }))
  } finally {
    await handle.close()
  }
}
