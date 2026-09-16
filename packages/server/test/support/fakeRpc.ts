import { Transaction } from '@nimiq/core'
import { decodeMemo, RpcError, type ChainTransaction, type RpcStaker } from '../../src/nimiq/rpc.js'
import { comparableAddress } from '../../src/lib/address.js'

export type PushedTransaction = {
  hash: string
  sender: string
  recipient: string
  valueLuna: bigint
  memo: string | null
  blockNumber: number | null
  blockTime: Date | null
}

/**
 * A Nimiq node that lives in this process. It deserialises the real signed bytes the
 * sender hands it, so a transaction that the chain would reject as malformed is
 * rejected here too, and it counts lookups so a test can say "this one is still in the
 * mempool" without waiting for a block.
 */
export class FakeRpc {
  head = 11_500_000
  network = 'TestAlbatross'

  /** The time a block carries, in milliseconds, which is the unit the real node uses. */
  blockTimeMs = Date.parse('2026-09-15T10:00:00Z')

  /** How many lookups a broadcast transaction stays unknown for before it lands. */
  includeAfter = 1

  /** When true every transaction lookup throws, the case that once caused a double payout. */
  failLookups = false

  /** When true the node refuses the broadcast, so nothing is on chain afterwards. */
  failPush: string | null = null

  readonly pushed: PushedTransaction[] = []

  readonly stakes = new Map<string, bigint>()

  private readonly lookups = new Map<string, number>()

  private readonly chain: ChainTransaction[] = []

  async getBlockNumber(): Promise<number> {
    return this.head
  }

  async getNetworkName(): Promise<string> {
    return this.network
  }

  async pushTransaction(rawHex: string): Promise<string> {
    if (this.failPush) throw new RpcError(this.failPush, -32603, this.failPush)

    const transaction = Transaction.deserialize(Uint8Array.from(Buffer.from(rawHex, 'hex')))
    const record: PushedTransaction = {
      hash: transaction.hash(),
      sender: transaction.sender.toUserFriendlyAddress().replace(/\s+/g, ''),
      recipient: transaction.recipient.toUserFriendlyAddress().replace(/\s+/g, ''),
      valueLuna: transaction.value,
      memo: decodeMemo(transaction.data),
      blockNumber: null,
      blockTime: null,
    }

    this.pushed.push(record)
    return record.hash
  }

  /**
   * Null means the node has not seen the hash yet, which is how a fresh broadcast reads
   * for its first few polls. A test that sets failLookups gets an error instead, and
   * the caller is expected to treat that as "still pending" rather than as a failure.
   */
  async fetchTransaction(hash: string): Promise<ChainTransaction | null> {
    if (this.failLookups) throw new RpcError('lookup unavailable', -32603, 'node is busy')

    const seen = (this.lookups.get(hash) ?? 0) + 1
    this.lookups.set(hash, seen)

    const record = this.pushed.find((tx) => tx.hash === hash)
    if (record) {
      if (seen <= this.includeAfter) return null
      record.blockNumber ??= this.head
      record.blockTime ??= new Date(this.blockTimeMs)
      return {
        hash: record.hash,
        blockNumber: record.blockNumber,
        blockTime: record.blockTime,
        sender: record.sender,
        recipient: record.recipient,
        valueLuna: record.valueLuna,
        memo: record.memo,
      }
    }

    const onChain = this.chain.find((tx) => tx.hash === hash)
    return onChain ?? null
  }

  async listIncoming(address: string, sinceBlock: number): Promise<ChainTransaction[]> {
    const wanted = comparableAddress(address)
    return this.chain
      .filter((tx) => comparableAddress(tx.recipient) === wanted && tx.blockNumber > sinceBlock)
      .sort((a, b) => a.blockNumber - b.blockNumber)
  }

  async getStakerByAddress(address: string): Promise<RpcStaker> {
    const balance = this.stakes.get(comparableAddress(address))
    if (balance === undefined) {
      const spaced = `No staker with address: ${address}`
      throw new RpcError('Internal error', -32603, spaced)
    }

    return {
      address,
      balance: Number(balance),
      delegation: null,
      inactiveBalance: 0,
      retiredBalance: 0,
      inactiveFrom: null,
    }
  }

  /** Puts a payment on the fake chain, the way a player's phone would. */
  receive(
    tx: Omit<ChainTransaction, 'blockNumber' | 'blockTime'> & { blockNumber?: number; blockTime?: Date | null },
  ): ChainTransaction {
    const placed: ChainTransaction = {
      ...tx,
      blockNumber: tx.blockNumber ?? this.head,
      blockTime: tx.blockTime ?? new Date(this.blockTimeMs),
    }
    this.chain.push(placed)
    return placed
  }

  /** How many times this hash has been looked up, so a test can prove there was no resend. */
  lookupCount(hash: string): number {
    return this.lookups.get(hash) ?? 0
  }

  mine(blocks = 1): number {
    this.head += blocks
    return this.head
  }
}
