// Covers the helpers around the RPC client. It does NOT cover the live RPC: every test
// here hands the client a canned answer, so a node that is down or that changes its
// response shape will not be caught by this file.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeMemo,
  fetchTransaction,
  listIncoming,
  RpcError,
  isNotFound,
  type RpcTransaction,
} from '../src/nimiq/rpc.js'

// recipientData copied from a real Nimiq mainnet transaction,
// hash 8f446c5be0c86ac6440ddcce9ed91f8e836f739c1b3c8595e838b46f67b6c3ad.
const REAL_MEMO_HEX = '596f75206d696e6564204e494d206f6e204e696d69712e537061636521'

const TREASURY = 'NQ63NLNX4H6RM3R4XB928Y1X5GTSJUGC5QFJ'
const PLAYER = 'NQ5492V5S1C3EAJFHVE6B2KB8U316D3DVUMC'

function node(overrides: Partial<RpcTransaction>): RpcTransaction {
  return {
    hash: 'a'.repeat(64),
    blockNumber: 11_148_228,
    timestamp: 0,
    confirmations: 1,
    from: PLAYER,
    fromType: 0,
    to: TREASURY,
    toType: 0,
    value: 100000,
    fee: 0,
    senderData: '',
    recipientData: '',
    validityStartHeight: 0,
    networkId: 5,
    ...overrides,
  }
}

describe('decodeMemo', () => {
  it('reads the text out of a real transaction data field', () => {
    expect(decodeMemo(REAL_MEMO_HEX)).toBe('You mined NIM on Nimiq.Space!')
  })

  it('reads the memo a shop payment carries', () => {
    expect(decodeMemo(Buffer.from('vettai:shop:1a2b3c4d', 'utf8').toString('hex'))).toBe('vettai:shop:1a2b3c4d')
  })

  it('returns null for a transaction with no data', () => {
    expect(decodeMemo('')).toBeNull()
    expect(decodeMemo(null)).toBeNull()
    expect(decodeMemo(undefined)).toBeNull()
  })

  it('returns null for binary that is not readable text', () => {
    expect(decodeMemo('00010203')).toBeNull()
    expect(decodeMemo('fffefd')).toBeNull()
    expect(decodeMemo('abc')).toBeNull()
  })
})

describe('isNotFound', () => {
  it('tells a missing transaction apart from a broken node', () => {
    expect(isNotFound(new RpcError('Internal error', -32603, 'Transaction not found'))).toBe(true)
    expect(isNotFound(new RpcError('RPC returned HTTP 502', 502))).toBe(false)
    expect(isNotFound(new Error('fetch failed'))).toBe(false)
  })
})

describe('fetchTransaction', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalises the addresses the node writes with spaces and holds value as luna', async () => {
    const canned = node({
      from: 'nq54 92v5 s1c3 eajf hve6 b2kb 8u31 6d3d vumc',
      to: 'NQ63 NLNX 4H6R M3R4 XB92 8Y1X 5GTS JUGC 5QFJ',
      recipientData: Buffer.from('vettai:1a2b3c4d', 'utf8').toString('hex'),
    })

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: canned } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const tx = await fetchTransaction(canned.hash)

    expect(tx?.sender).toBe(PLAYER)
    expect(tx?.recipient).toBe(TREASURY)
    expect(tx?.valueLuna).toBe(100000n)
    expect(tx?.memo).toBe('vettai:1a2b3c4d')
  })

  it('reads null for a hash the node has never seen', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', data: 'Transaction not found' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    expect(await fetchTransaction('b'.repeat(64))).toBeNull()
  })
})

describe('listIncoming', () => {
  it('keeps only payments into the address that are newer than the cursor', async () => {
    const rows = [
      node({ hash: '1'.repeat(64), blockNumber: 100, to: TREASURY }),
      node({ hash: '2'.repeat(64), blockNumber: 120, to: TREASURY }),
      node({ hash: '3'.repeat(64), blockNumber: 130, from: TREASURY, to: PLAYER }),
    ]

    const found = await listIncoming(TREASURY, 110, { fetchPage: async () => rows })

    expect(found.map((tx) => tx.hash)).toEqual(['2'.repeat(64)])
  })

  it('walks back through full pages until it reaches the cursor', async () => {
    const asked: (string | null)[] = []
    const pages: RpcTransaction[][] = [
      [node({ hash: 'a'.repeat(64), blockNumber: 220 }), node({ hash: 'b'.repeat(64), blockNumber: 210 })],
      [node({ hash: 'c'.repeat(64), blockNumber: 205 }), node({ hash: 'd'.repeat(64), blockNumber: 90 })],
    ]

    const found = await listIncoming(TREASURY, 200, {
      pageSize: 2,
      fetchPage: async (_address, _max, beforeHash) => {
        asked.push(beforeHash)
        return pages[asked.length - 1] ?? []
      },
    })

    expect(asked).toEqual([null, 'b'.repeat(64)])
    expect(found.map((tx) => tx.blockNumber)).toEqual([205, 210, 220])
  })

  it('reads nothing for something that is not an address', async () => {
    expect(await listIncoming('not-an-address', 0, { fetchPage: async () => [] })).toEqual([])
  })
})
