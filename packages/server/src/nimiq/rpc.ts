import { config } from '../config.js'
import { formatAddress, normalizeAddress } from '../lib/address.js'

/** One transaction exactly as the Albatross JSON-RPC node returns it. */
export type RpcTransaction = {
  hash: string
  blockNumber: number
  timestamp: number
  confirmations: number
  from: string
  fromType: number
  to: string
  toType: number
  value: number
  fee: number
  senderData: string
  recipientData: string
  validityStartHeight: number
  networkId: number
  executionResult?: boolean
}

/** What the node knows about an address. Staking accounts carry more fields than this. */
export type RpcAccount = {
  address: string
  balance: number
  type: string
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** True when the node's answer means "no such transaction", not "something broke". */
export function isNotFound(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false
  const detail = typeof error.data === 'string' ? error.data : ''
  return /not found/i.test(detail) || /not found/i.test(error.message)
}

let nextId = 1

/** How long one call may take before it counts as a node that never answered. */
export const RPC_TIMEOUT_MS = 15_000

/**
 * True when the node never gave an answer, as opposed to answering "no".
 *
 * A JSON-RPC error body is an answer and is handed straight back, so "transaction not
 * found" keeps meaning what it says. A timeout, a dropped connection, a 429 or a 5xx is the
 * node failing to speak, and only those are worth asking again.
 */
export function isNodeSilent(error: unknown): boolean {
  if (error instanceof RpcError) return error.code === 429 || error.code >= 500
  return true
}

async function callNode<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new RpcError(`RPC ${method} returned HTTP ${response.status}`, response.status)
  }

  const body = (await response.json()) as {
    result?: { data: T }
    error?: { code: number; message: string; data?: unknown }
  }

  if (body.error) throw new RpcError(body.error.message, body.error.code, body.error.data)
  if (!body.result) throw new RpcError(`RPC ${method} returned no result`, -1)

  return body.result.data
}

/**
 * One call to the node, with one retry and an optional second node behind it.
 *
 * A public node that hiccups is the likeliest thing to go wrong in this whole server, and
 * the treasury must never read a hiccup as a fact about money. A silent node is therefore
 * asked twice before NIMIQ_RPC_FALLBACK_URL, when it is set, is asked once. An answer the
 * node really gave, error included, is never retried: it is already the truth.
 */
async function call<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown = new RpcError(`RPC ${method} was never called`, -1)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await callNode<T>(config.NIMIQ_RPC_URL, method, params)
    } catch (error) {
      if (!isNodeSilent(error)) throw error
      last = error
    }
  }

  const fallback = config.NIMIQ_RPC_FALLBACK_URL
  if (fallback) {
    try {
      return await callNode<T>(fallback, method, params)
    } catch (error) {
      if (!isNodeSilent(error)) throw error
      last = error
    }
  }

  throw last
}

export function getBlockNumber(): Promise<number> {
  return call<number>('getBlockNumber', [])
}

export function getTransactionByHash(hash: string): Promise<RpcTransaction> {
  return call<RpcTransaction>('getTransactionByHash', [hash])
}

/** The node only accepts the spaced form of an address, so every caller gets it for free. */
export function getAccountByAddress(address: string): Promise<RpcAccount> {
  return call<RpcAccount>('getAccountByAddress', [formatAddress(address)])
}

/** A staker record as the node returns it. Every amount is a whole number of luna. */
export type RpcStaker = {
  address: string
  balance: number
  delegation: string | null
  inactiveBalance: number
  retiredBalance: number
  inactiveFrom: number | null
}

/**
 * What the node has staked for one address. Read live from rpc.nimiqwatch.com on
 * 15 September 2026: the record carries balance, delegation, inactiveBalance,
 * retiredBalance and inactiveFrom, and an address that never staked comes back as the
 * error below rather than as an empty record.
 */
export function getStakerByAddress(address: string): Promise<RpcStaker> {
  return call<RpcStaker>('getStakerByAddress', [formatAddress(address)])
}

/** True when the node means "this wallet has never staked", which is not a failure. */
export function isNoStaker(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false
  const detail = typeof error.data === 'string' ? error.data : ''
  return /no staker with address/i.test(detail) || /no staker with address/i.test(error.message)
}

/** The head of the chain. Only the fields Vettai reads are named here. */
export type RpcBlock = {
  hash: string
  number: number
  network: string
  type: string
}

export function getLatestBlock(includeBody = false): Promise<RpcBlock> {
  return call<RpcBlock>('getLatestBlock', [includeBody])
}

/**
 * Which chain this node is actually on, in the same words as NIMIQ_NETWORK. There is no
 * getNetworkId method on the public nodes ("Method not allowed"), but every block names
 * its own network, so the head block is the answer.
 */
export async function getNetworkName(): Promise<string> {
  const head = await getLatestBlock()
  return head.network
}

/**
 * Hands a signed transaction to the node. The transaction is built and signed in the
 * treasury, so the node only relays it: it never sees a key. Answers with the hash it
 * will be known by on chain, the same hash the signer computed before broadcasting.
 */
export function pushTransaction(rawHex: string): Promise<string> {
  return call<string>('pushTransaction', [rawHex])
}

/**
 * The node rejects this call with "expected struct ... with 3 elements" unless the
 * third parameter is present, so the trailing null is required, not optional. Passing a
 * transaction hash there asks the node for the page before that transaction.
 */
export function getTransactionsByAddress(
  address: string,
  max: number,
  beforeHash: string | null = null,
): Promise<RpcTransaction[]> {
  return call<RpcTransaction[]>('getTransactionsByAddress', [formatAddress(address), max, beforeHash])
}

/**
 * Turns a transaction's data field into the text a person typed. The node hands the
 * field back as hex, empty string when there is no memo. Returns null for anything that
 * is not printable text, since staking and contract transactions put binary in here.
 */
export function decodeMemo(hexOrBytes: string | Uint8Array | null | undefined): string | null {
  if (hexOrBytes == null) return null

  let bytes: Uint8Array
  if (typeof hexOrBytes === 'string') {
    const trimmed = hexOrBytes.trim()
    if (trimmed.length === 0) return null
    if (trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(trimmed)) return null
    bytes = Uint8Array.from(Buffer.from(trimmed, 'hex'))
  } else {
    bytes = hexOrBytes
  }

  if (bytes.byteLength === 0) return null

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null
  }
  return text
}

/** One payment, read off the chain and decoded into the fields Vettai needs. */
export type ChainTransaction = {
  hash: string
  blockNumber: number
  /** When the block was produced. Null when the node did not give a usable time. */
  blockTime: Date | null
  sender: string
  recipient: string
  valueLuna: bigint
  memo: string | null
  /** Blocks on top of the one carrying this transaction, when the node counted them. */
  confirmations?: number
}

export function toChainTransaction(tx: RpcTransaction): ChainTransaction {
  return {
    hash: tx.hash,
    blockNumber: typeof tx.blockNumber === 'number' ? tx.blockNumber : 0,
    // The node's timestamp is in milliseconds, not seconds. Measured against the payout
    // 368959fef24ca5c6d2e1171fc292cbfc3617797e38c29cf8c5d14683829974ea on the testnet: it
    // reads 1789488893326, which is 15 September 2026 at 16:14 UTC, the minute the prove
    // run made it. Read as seconds the same number lands tens of thousands of years out.
    blockTime: typeof tx.timestamp === 'number' && tx.timestamp > 0 ? new Date(tx.timestamp) : null,
    sender: normalizeAddress(tx.from) ?? tx.from.replace(/\s+/g, '').toUpperCase(),
    recipient: normalizeAddress(tx.to) ?? tx.to.replace(/\s+/g, '').toUpperCase(),
    valueLuna: BigInt(tx.value ?? 0),
    memo: decodeMemo(tx.recipientData),
    ...(typeof tx.confirmations === 'number' && tx.confirmations > 0
      ? { confirmations: tx.confirmations }
      : {}),
  }
}

/**
 * True when the node is holding this hash in its own mempool, and true again when it could
 * not say.
 *
 * "I do not know" has to read as "it may still be in there": the treasury only rebuilds a
 * payout it is certain was never accepted, and a node that is busy or offline proves
 * nothing. rpc.nimiqwatch.com answers "Transaction not found" for hashes sitting in its own
 * mempool, which is exactly why this is asked separately rather than read off a lookup.
 */
export async function mempoolHas(hash: string): Promise<boolean> {
  const wanted = hash.trim().toLowerCase()

  let content: unknown[]
  try {
    content = await call<unknown[]>('mempoolContent', [false])
  } catch {
    return true
  }

  return content.some((entry) => {
    if (typeof entry === 'string') return entry.trim().toLowerCase() === wanted
    const inner = (entry as { hash?: unknown }).hash
    return typeof inner === 'string' && inner.trim().toLowerCase() === wanted
  })
}

/** Null means the node has never seen this hash, which is not an error: it may be seconds old. */
export async function fetchTransaction(hash: string): Promise<ChainTransaction | null> {
  try {
    return toChainTransaction(await getTransactionByHash(hash))
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** The node's own ceiling per call. A busy address is read as several of these. */
export const PAGE_SIZE = 500

/**
 * Stops a broken or hostile node from holding the watcher in a loop. 20 full pages is
 * 10,000 transactions into one address since the last pass, which the treasury never
 * reaches in a few seconds.
 */
export const MAX_PAGES = 20

export type PageFetcher = (
  address: string,
  max: number,
  beforeHash: string | null,
) => Promise<RpcTransaction[]>

/**
 * Payments into one address that are newer than the block we last looked at. The node
 * hands back both directions, so the filtering happens here rather than at every call
 * site. Oldest first, so a caller can settle them in the order they happened.
 *
 * A full page means there is more behind it, so the next call carries the last hash and
 * asks for the page before it. Without that, a busy shop address would have its older
 * payments cut off and never settled. Reading stops as soon as a page reaches back past
 * the cursor, because everything older than that was handled on an earlier pass.
 */
async function walkPages(
  address: string,
  sinceBlock: number,
  keep: (tx: ChainTransaction, wanted: string) => boolean,
  options: { pageSize?: number; fetchPage?: PageFetcher } = {},
): Promise<ChainTransaction[]> {
  const wanted = normalizeAddress(address)
  if (!wanted) return []

  const pageSize = options.pageSize ?? PAGE_SIZE
  const fetchPage = options.fetchPage ?? getTransactionsByAddress
  const spaced = formatAddress(wanted)

  const seen = new Map<string, ChainTransaction>()
  let beforeHash: string | null = null

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await fetchPage(spaced, pageSize, beforeHash)
    if (rows.length === 0) break

    let reachedCursor = false
    for (const row of rows) {
      const tx = toChainTransaction(row)
      if (tx.blockNumber <= sinceBlock) reachedCursor = true
      if (tx.blockNumber > sinceBlock && keep(tx, wanted)) seen.set(tx.hash, tx)
    }

    if (rows.length < pageSize || reachedCursor) break
    beforeHash = rows[rows.length - 1]?.hash ?? null
    if (!beforeHash) break
  }

  return [...seen.values()].sort((a, b) => a.blockNumber - b.blockNumber)
}

export function listIncoming(
  address: string,
  sinceBlock: number,
  options: { pageSize?: number; fetchPage?: PageFetcher } = {},
): Promise<ChainTransaction[]> {
  return walkPages(address, sinceBlock, (tx, wanted) => tx.recipient === wanted, options)
}

/**
 * Payments this address has made since a block, which is how the treasury asks the chain
 * "did I already pay this one?" after a crash.
 *
 * It is the mirror of listIncoming and it reads the same pages: the node hands back both
 * directions, so the sender filter happens here. A memo found in this list is proof a
 * payout went out, whatever the treasury's own row says.
 */
export function listOutgoing(
  address: string,
  sinceBlock: number,
  options: { pageSize?: number; fetchPage?: PageFetcher } = {},
): Promise<ChainTransaction[]> {
  return walkPages(address, sinceBlock, (tx, wanted) => tx.sender === wanted, options)
}
