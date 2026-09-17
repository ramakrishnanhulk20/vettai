import { Address, KeyPair, PrivateKey, TransactionBuilder, type Transaction } from '@nimiq/core'
import { canonical, normalizeAddress } from '../lib/address.js'
import { sleep } from '../lib/sleep.js'
import type { ChainTransaction } from '../nimiq/rpc.js'

/**
 * Albatross network ids. 5 was read off a live testnet transaction and 24 off a live
 * mainnet one on 15 September 2026, so both are measured rather than copied from a page.
 */
const NETWORK_IDS: Record<string, number> = { TestAlbatross: 5, MainAlbatross: 24 }

/** The largest memo Nimiq carries in a basic transaction. */
export const MAX_MEMO_BYTES = 64

/** How often a broadcast transaction is looked for while waiting for a block. */
export const POLL_MS = 2000

export function networkIdFor(network: string): number {
  const id = NETWORK_IDS[network]
  if (id === undefined) throw new Error(`${network} is not a Nimiq network this treasury knows`)
  return id
}

export type SenderRpc = {
  getBlockNumber: () => Promise<number>
  pushTransaction: (rawHex: string) => Promise<string>
  fetchTransaction: (hash: string) => Promise<ChainTransaction | null>
  getAccountByAddress: (address: string) => Promise<{ balance: number }>
  mempoolHas: (hash: string) => Promise<boolean>
  listOutgoing: (address: string, sinceBlock: number) => Promise<ChainTransaction[]>
}

export type SendInput = {
  to: string
  valueLuna: bigint
  memo: string
  /**
   * Called with the hash and the height it was built at, after signing and before the
   * broadcast, so the caller can write both down first. A payment whose hash was never
   * saved is a payment nobody can look up afterwards, and the height is what later says
   * whether the chain could still accept it.
   */
  onSigned?: (hash: string, validityStartHeight: number) => Promise<void> | void
}

/**
 * How long the chain will accept a transaction built at a given height:
 * TRANSACTION_VALIDITY_WINDOW_BLOCKS on @nimiq/core 2.21.0, at roughly one block a second.
 */
export const VALIDITY_WINDOW_BLOCKS = 7200

/**
 * The blocks a payment has to be buried under before the treasury calls it final. It is
 * BLOCKS_PER_BATCH on Albatross: one full batch on top of the block that carries it.
 */
export const FINALITY_BLOCKS = 60

export type Inclusion = { blockNumber: number } | { pending: true }

/**
 * The three answers a node can give about a hash, kept apart because they mean different
 * things to money. In a block is settled. Pending is "ask again". Unknown is the only one
 * that says nothing was ever accepted, and it is the only one a payout may be rebuilt on.
 */
export type Lookup =
  | { blockNumber: number; confirmations?: number }
  | { pending: true }
  | { unknown: true }

export type Sender = {
  address: string
  send: (input: SendInput) => Promise<{ hash: string }>
  waitInclusion: (hash: string, timeoutMs?: number) => Promise<Inclusion>
  lookup: (hash: string) => Promise<Lookup>
  /** The head of the chain, which is how far the validity window and finality are measured. */
  head: () => Promise<number>
  /** What the treasury wallet holds right now, in luna. */
  balanceLuna: () => Promise<bigint>
  /** True when the node still holds this hash, and true again when it could not say. */
  mempoolHas: (hash: string) => Promise<boolean>
  /** Everything this wallet has paid out since a block, memos included. */
  outgoingSince: (sinceBlock: number) => Promise<ChainTransaction[]>
}

export type SenderOptions = {
  privateKeyHex: string
  network: string
  rpc: SenderRpc
  /** Only tests change this. The chain does not produce blocks faster than this anyway. */
  pollMs?: number
}

export function buildSignedTransaction(input: {
  keyPair: KeyPair
  to: string
  valueLuna: bigint
  memo: string
  validityStartHeight: number
  networkId: number
}): Transaction {
  const recipient = normalizeAddress(input.to)
  if (!recipient) throw new Error(`${input.to} is not a Nimiq address`)

  if (input.valueLuna <= 0n) throw new Error(`a payment has to be worth more than nothing`)

  const data = new TextEncoder().encode(input.memo)
  if (data.byteLength > MAX_MEMO_BYTES) {
    throw new Error(`the memo is ${data.byteLength} bytes, the limit is ${MAX_MEMO_BYTES}`)
  }

  const sender = input.keyPair.toAddress()
  if (canonical(sender) === recipient) {
    throw new Error('a Nimiq transaction cannot pay its own sender')
  }

  const transaction = TransactionBuilder.newBasicWithData(
    sender,
    Address.fromUserFriendlyAddress(recipient),
    data,
    input.valueLuna,
    0n,
    input.validityStartHeight,
    input.networkId,
  )

  transaction.sign(input.keyPair, undefined)

  return transaction
}

/**
 * The one thing in Vettai that can move NIM.
 *
 * It signs in this process and the node only relays finished bytes, so the key never
 * leaves the treasury. Both networks are allowed here on purpose: refusing the mainnet
 * belongs in refuse.ts, which checks the key, the address and the node together at boot,
 * rather than in the place that does the signing.
 */
export function createSender(options: SenderOptions): Sender {
  const keyPair = KeyPair.derive(PrivateKey.fromHex(options.privateKeyHex))
  const networkId = networkIdFor(options.network)
  const pollMs = options.pollMs ?? POLL_MS
  const address = canonical(keyPair)

  return {
    address,

    async send(input: SendInput): Promise<{ hash: string }> {
      const validityStartHeight = await options.rpc.getBlockNumber()

      const transaction = buildSignedTransaction({
        keyPair,
        to: input.to,
        valueLuna: input.valueLuna,
        memo: input.memo,
        validityStartHeight,
        networkId,
      })

      const hash = transaction.hash()
      await input.onSigned?.(hash, validityStartHeight)

      await options.rpc.pushTransaction(Buffer.from(transaction.serialize()).toString('hex'))

      return { hash }
    },

    head: () => options.rpc.getBlockNumber(),

    async balanceLuna(): Promise<bigint> {
      const account = await options.rpc.getAccountByAddress(address)
      if (!Number.isInteger(account.balance) || account.balance < 0) {
        throw new Error(`the node reported a balance of ${account.balance}, which is not whole luna`)
      }
      return BigInt(account.balance)
    },

    mempoolHas: (hash: string) => options.rpc.mempoolHas(hash),

    outgoingSince: (sinceBlock: number) => options.rpc.listOutgoing(address, sinceBlock),

    /**
     * Asks the node about one hash, once.
     *
     * A lookup that throws is never "unknown": a node that is busy, rate limiting or
     * offline knows nothing about whether the payment exists, and treating that as
     * "nothing was sent" is exactly the mistake that paid a player twice in the game this
     * borrows from. Only a node that answered, and answered that it has never heard of
     * the hash, gives back unknown.
     */
    async lookup(hash: string): Promise<Lookup> {
      let found: ChainTransaction | null
      try {
        found = await options.rpc.fetchTransaction(hash)
      } catch {
        return { pending: true }
      }

      if (!found) return { unknown: true }
      if (found.blockNumber <= 0) return { pending: true }

      return found.confirmations !== undefined && found.confirmations > 0
        ? { blockNumber: found.blockNumber, confirmations: found.confirmations }
        : { blockNumber: found.blockNumber }
    },

    /**
     * Waits for a broadcast payment to land in a block.
     *
     * A lookup that fails is treated as "still pending", never as a failure, and the
     * answer is never "send it again". That exact mistake, re-broadcasting on a transient
     * lookup error, is what paid a player twice in the game this borrows from.
     */
    async waitInclusion(hash: string, timeoutMs = 120_000): Promise<Inclusion> {
      const deadline = Date.now() + timeoutMs

      for (;;) {
        const found = await options.rpc.fetchTransaction(hash).catch(() => null)
        if (found && found.blockNumber > 0) return { blockNumber: found.blockNumber }
        if (Date.now() >= deadline) return { pending: true }
        await sleep(pollMs)
      }
    },
  }
}
