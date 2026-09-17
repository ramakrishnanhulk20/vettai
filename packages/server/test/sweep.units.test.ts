// Covers the treasury sweep command: what the arguments mean, every refusal, the plan a
// dry run prints, and one whole send against a node that lives in this process. It does
// NOT reach a real node, prove that the chain accepts the bytes, or read a real env file:
// the live testnet sweep in DEPLOY.md covers those, and the key handling itself is
// covered by config.test.ts and refuse.test.ts.

import { KeyPair, PrivateKey } from '@nimiq/core'
import { describe, expect, it } from 'vitest'
import { formatAddress } from '../src/lib/address.js'
import {
  balanceLuna,
  credentialsFromEnvFile,
  DEFAULT_MEMO,
  formatPlan,
  parseSweepArguments,
  planSweep,
  runSweep,
  treasuryEnvFileFrom,
  type SweepArguments,
  type SweepRpc,
} from '../src/cli/sweep.js'
import { randomAddress } from './support/db.js'
import { FakeRpc } from './support/fakeRpc.js'

const KEY_HEX = PrivateKey.generate().toHex()
const TREASURY = KeyPair.derive(PrivateKey.fromHex(KEY_HEX)).toAddress().toUserFriendlyAddress().replace(/\s+/g, '')

function node(rpc: FakeRpc, balance: bigint): SweepRpc {
  return {
    getBlockNumber: () => rpc.getBlockNumber(),
    getNetworkName: () => rpc.getNetworkName(),
    fetchTransaction: (hash) => rpc.fetchTransaction(hash),
    pushTransaction: (rawHex) => rpc.pushTransaction(rawHex),
    getAccountByAddress: async () => ({ balance: Number(balance) }),
    mempoolHas: (hash) => rpc.mempoolHas(hash),
    listOutgoing: (address, sinceBlock) => rpc.listOutgoing(address, sinceBlock),
  }
}

function asked(overrides: Partial<SweepArguments> = {}): SweepArguments {
  return { to: randomAddress(), amount: null, memo: DEFAULT_MEMO, yes: false, ...overrides }
}

async function sweep(
  rpc: FakeRpc,
  balance: bigint,
  args: SweepArguments,
  timeoutMs = 50,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const code = await runSweep({
    privateKeyHex: KEY_HEX,
    expectedAddress: TREASURY,
    network: 'TestAlbatross',
    rpc: node(rpc, balance),
    args,
    say: (line) => lines.push(line),
    timeoutMs,
    pollMs: 1,
  })
  return { code, lines }
}

describe('parseSweepArguments', () => {
  it('reads an address pasted in the spaced form Nimiq prints, without quotes', () => {
    const args = parseSweepArguments('--to NQ63 NLNX 4H6R M3R4 XB92 8Y1X 5GTS JUGC 5QFJ'.split(' '))
    expect(args.to).toBe('NQ63 NLNX 4H6R M3R4 XB92 8Y1X 5GTS JUGC 5QFJ')
    expect(args).toMatchObject({ amount: null, memo: DEFAULT_MEMO, yes: false })
  })

  it('takes an amount, a memo of several words, and the go-ahead', () => {
    const args = parseSweepArguments(['--to', 'NQ07', '--amount', '0.1', '--memo', 'back to', 'Ram', '--yes'])
    expect(args).toEqual({ to: 'NQ07', amount: '0.1', memo: 'back to Ram', yes: true })
  })

  it('refuses an option it does not know, rather than sending the whole balance on a typo', () => {
    expect(() => parseSweepArguments(['--to', 'NQ07', '--ammount', '0.1', '--yes'])).toThrow(/--ammount is not/)
    expect(() => parseSweepArguments(['--to', 'NQ07', '--to', 'NQ08'])).toThrow(/written twice/)
    expect(() => parseSweepArguments(['NQ07'])).toThrow(/has no option in front of it/)
  })

  it('refuses a missing recipient and an option left without its value', () => {
    expect(() => parseSweepArguments(['--yes'])).toThrow(/--to needs/)
    expect(() => parseSweepArguments(['--to', '--yes'])).toThrow(/--to needs a value/)
    expect(() => parseSweepArguments(['--to', 'NQ07', '--amount'])).toThrow(/--amount needs a value/)
  })
})

describe('planSweep', () => {
  const base = { network: 'TestAlbatross', from: TREASURY, memo: DEFAULT_MEMO, balanceLuna: 200_000n }

  it('sends the whole balance when no amount is written', () => {
    const plan = planSweep({ ...base, to: randomAddress(), amount: null })
    expect(plan).toMatchObject({ valueLuna: 200_000n, whole: true })
  })

  it('refuses an address that is not a Nimiq address', () => {
    expect(() => planSweep({ ...base, to: 'NQ63 NLNX 4H6R M3R4 XB92 8Y1X 5GTS JUGC 5QFX', amount: null })).toThrow(
      /is not a Nimiq address/,
    )
    expect(() => planSweep({ ...base, to: '0x1234', amount: null })).toThrow(/is not a Nimiq address/)
  })

  it('refuses more than the wallet holds, and anything at or below nothing', () => {
    expect(() => planSweep({ ...base, to: randomAddress(), amount: '2.00001' })).toThrow(
      /the amount is 2.00001 NIM and the wallet holds 2 NIM/,
    )
    expect(() => planSweep({ ...base, to: randomAddress(), amount: '0' })).toThrow(/more than nothing/)
    expect(() => planSweep({ ...base, to: randomAddress(), amount: '-1' })).toThrow(/more than nothing/)
    expect(() => planSweep({ ...base, to: randomAddress(), amount: 'all of it' })).toThrow(/not an amount of NIM/)
  })

  it('refuses to pay the treasury itself, however the address is written', () => {
    expect(() => planSweep({ ...base, to: formatAddress(TREASURY).toLowerCase(), amount: null })).toThrow(
      /paying itself/,
    )
  })

  it('refuses an empty wallet and a memo longer than Nimiq carries', () => {
    expect(() => planSweep({ ...base, to: randomAddress(), amount: null, balanceLuna: 0n })).toThrow(
      /nothing to sweep/,
    )
    expect(() => planSweep({ ...base, to: randomAddress(), amount: null, memo: 'x'.repeat(65) })).toThrow(
      /the memo is 65 bytes/,
    )
  })
})

describe('formatPlan', () => {
  it('writes the network, both addresses, and what the wallet is left with', () => {
    const to = randomAddress()
    const lines = formatPlan(
      planSweep({ network: 'TestAlbatross', from: TREASURY, to, amount: '0.1', memo: 'back', balanceLuna: 200_000n }),
    )

    expect(lines).toEqual([
      'network   TestAlbatross',
      `from      ${formatAddress(TREASURY)}`,
      `to        ${formatAddress(to)}`,
      'balance   2 NIM',
      'sending   0.1 NIM (leaving 1.9 NIM)',
      'memo      back',
    ])
  })
})

describe('balanceLuna', () => {
  it('refuses a balance the node did not give as a whole number of luna', () => {
    expect(balanceLuna({ balance: 200_000 })).toBe(200_000n)
    expect(() => balanceLuna({ balance: 1.5 })).toThrow(/not a whole number of luna/)
    expect(() => balanceLuna({ balance: -1 })).toThrow(/not a whole number of luna/)
  })
})

describe('runSweep', () => {
  it('prints the plan and sends nothing until --yes is written', async () => {
    const rpc = new FakeRpc()
    const to = randomAddress()
    const run = await sweep(rpc, 200_000n, asked({ to, amount: '0.1' }))

    expect(run.code).toBe(1)
    expect(rpc.pushed).toHaveLength(0)
    expect(run.lines[0]).toBe('network   TestAlbatross')
    expect(run.lines).toContain('sending   0.1 NIM (leaving 1.9 NIM)')
    expect(run.lines.at(-1)).toBe('nothing was sent. Run the same command again with --yes to send it')
  })

  it('signs, broadcasts and reports the hash and the block once --yes is written', async () => {
    const rpc = new FakeRpc()
    const to = randomAddress()
    const run = await sweep(rpc, 200_000n, asked({ to, amount: '0.1', memo: 'back to Ram', yes: true }))

    expect(run.code).toBe(0)
    expect(rpc.pushed).toHaveLength(1)
    expect(rpc.pushed[0]).toMatchObject({
      sender: TREASURY,
      recipient: to,
      valueLuna: 10_000n,
      memo: 'back to Ram',
    })
    expect(run.lines).toContain(`hash      ${rpc.pushed[0]?.hash}`)
    expect(run.lines.at(-2)).toBe(`block     ${rpc.head}`)
    expect(run.lines.at(-1)).toBe(`sent      0.1 NIM to ${formatAddress(to)}`)
  })

  it('empties the wallet when no amount is named', async () => {
    const rpc = new FakeRpc()
    const run = await sweep(rpc, 123_456n, asked({ yes: true }))

    expect(run.code).toBe(0)
    expect(rpc.pushed[0]?.valueLuna).toBe(123_456n)
    expect(run.lines).toContain('sending   1.23456 NIM (the whole balance)')
  })

  it('refuses when the node is on a different network from the one the environment names', async () => {
    const rpc = new FakeRpc()
    rpc.network = 'MainAlbatross'

    await expect(sweep(rpc, 200_000n, asked({ yes: true }))).rejects.toThrow(/the node is on MainAlbatross/)
    expect(rpc.pushed).toHaveLength(0)
  })

  it('refuses an amount above the balance before anything is signed', async () => {
    const rpc = new FakeRpc()

    await expect(sweep(rpc, 200_000n, asked({ amount: '3', yes: true }))).rejects.toThrow(/the wallet holds 2 NIM/)
    expect(rpc.pushed).toHaveLength(0)
  })

  it('says the payment is still out there when no block carries it in time, and never resends', async () => {
    const rpc = new FakeRpc()
    rpc.failLookups = true
    const run = await sweep(rpc, 200_000n, asked({ yes: true }))

    expect(run.code).toBe(1)
    expect(rpc.pushed).toHaveLength(1)
    expect(run.lines.at(-1)).toMatch(/Do not send it again/)
  })
})

describe('the key the sweep signs with', () => {
  it('reads the key and the address out of an env file and leaves a blank one as missing', () => {
    const file = `TREASURY_ADDRESS=${TREASURY}\nTREASURY_PRIVATE_KEY=${KEY_HEX}\n`
    expect(credentialsFromEnvFile(file)).toEqual({ address: TREASURY, privateKeyHex: KEY_HEX })
    expect(credentialsFromEnvFile('TREASURY_PRIVATE_KEY=\n')).toEqual({ address: null, privateKeyHex: null })
  })

  it('reads TREASURY_ENV_FILE against the server folder, and takes an absolute path as given', () => {
    expect(treasuryEnvFileFrom({}, '/srv')).toBeNull()
    expect(treasuryEnvFileFrom({ TREASURY_ENV_FILE: '  ' }, '/srv')).toBeNull()
    expect(treasuryEnvFileFrom({ TREASURY_ENV_FILE: '.env.mainnet.treasury' }, '/srv')).toMatch(
      /env\.mainnet\.treasury$/,
    )
  })
})
