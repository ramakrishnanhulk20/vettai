import { KeyPair, PrivateKey } from '@nimiq/core'
import { canonical, comparableAddress } from '../lib/address.js'
import { sleep } from '../lib/sleep.js'

/** A key that is not the treasury's. Waiting does not fix this one, so it is thrown apart. */
export class TreasuryKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TreasuryKeyError'
  }
}

export type RefuseRpc = {
  getNetworkName: () => Promise<string>
}

export type TreasuryCheck = {
  privateKeyHex: string
  expectedAddress: string
  network: string
  rpc: RefuseRpc
}

export type TreasuryIdentity = {
  address: string
  network: string
}

/**
 * The two questions the treasury has to answer before it is allowed to spend anything:
 * is this key really the wallet we say we pay from, and is this node really the chain we
 * say we are on.
 *
 * Both are cheap and both are catastrophic to get wrong. A key that derives a different
 * address pays out of a wallet nobody is watching, and a node on the other network turns
 * a testnet demo into real money leaving a real wallet. Failing at boot is the whole
 * point: the alternative is finding out at the moment somebody is owed a payout.
 */
export async function assertTreasuryConfig(input: TreasuryCheck): Promise<TreasuryIdentity> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.privateKeyHex ?? '')) {
    throw new TreasuryKeyError('TREASURY_PRIVATE_KEY has to be 64 hex characters')
  }

  let address: string
  try {
    address = canonical(KeyPair.derive(PrivateKey.fromHex(input.privateKeyHex)))
  } catch (error) {
    throw new TreasuryKeyError(
      `TREASURY_PRIVATE_KEY is not a Nimiq key: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (comparableAddress(address) !== comparableAddress(input.expectedAddress)) {
    throw new TreasuryKeyError(
      `TREASURY_PRIVATE_KEY belongs to ${address}, but TREASURY_ADDRESS says ${input.expectedAddress}`,
    )
  }

  const reported = await input.rpc.getNetworkName()
  if (reported !== input.network) {
    throw new Error(`NIMIQ_NETWORK says ${input.network}, but the node is on ${reported}`)
  }

  return { address, network: reported }
}

/** The first wait after a node that could not be reached at boot. */
export const FIRST_WAIT_MS = 5000

/** The longest the treasury waits between two goes at the same question. */
export const MAX_WAIT_MS = 2 * 60 * 1000

export type WaitOptions = {
  log?: (line: string) => void
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  firstWaitMs?: number
  maxWaitMs?: number
}

/**
 * The same two questions, asked until the node answers them.
 *
 * A key that cannot derive the address it claims will never start, because nothing about
 * that gets better with time. A node that is down, rate limiting or on the wrong chain is a
 * different thing: the treasury waits and asks again, forever, rather than exiting and
 * taking its health page and its queue with it. The host sees a process that is up and
 * saying why it is not paying anybody yet, which is what an operator can act on.
 */
export async function waitForTreasuryConfig(
  input: TreasuryCheck,
  options: WaitOptions = {},
): Promise<TreasuryIdentity> {
  const log = options.log ?? ((line: string) => console.log(line))
  const nap = options.sleep ?? ((ms: number, signal?: AbortSignal) => sleep(ms, signal))
  const maxWait = options.maxWaitMs ?? MAX_WAIT_MS

  let wait = options.firstWaitMs ?? FIRST_WAIT_MS

  for (;;) {
    try {
      return await assertTreasuryConfig(input)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      if (error instanceof TreasuryKeyError) throw error
      if (options.signal?.aborted) throw error

      log(`the treasury cannot start yet: ${why}. Trying again in ${Math.round(wait / 1000)}s`)
      await nap(wait, options.signal)
      if (options.signal?.aborted) throw error
      wait = Math.min(maxWait, wait * 2)
    }
  }
}
