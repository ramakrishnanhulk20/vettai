// Covers signing a payout and waiting for it to land, against a node that lives in this
// process. It does NOT prove a real node accepts the bytes or that the treasury has the
// balance: the prove-it run against the testnet covers those.

import { KeyPair, PrivateKey } from '@nimiq/core'
import { describe, expect, it } from 'vitest'
import { createSender, networkIdFor } from '../src/treasury/sender.js'
import { randomAddress, randomHash } from './support/db.js'
import { FakeRpc } from './support/fakeRpc.js'

const KEY_HEX = PrivateKey.generate().toHex()
const OWN_ADDRESS = KeyPair.derive(PrivateKey.fromHex(KEY_HEX)).toAddress().toUserFriendlyAddress().replace(/\s+/g, '')

function sender(rpc: FakeRpc, network = 'TestAlbatross') {
  return createSender({ privateKeyHex: KEY_HEX, network, rpc, pollMs: 1 })
}

describe('createSender', () => {
  it('knows its own address and both Albatross networks', () => {
    const rpc = new FakeRpc()

    expect(sender(rpc).address).toBe(OWN_ADDRESS)
    expect(networkIdFor('TestAlbatross')).toBe(5)
    expect(networkIdFor('MainAlbatross')).toBe(24)
    expect(() => networkIdFor('Testnet')).toThrow(/not a Nimiq network/)
  })

  it('hands the hash over before the payment is broadcast', async () => {
    const rpc = new FakeRpc()
    const to = randomAddress()
    const order: string[] = []

    const sent = await sender(rpc).send({
      to,
      valueLuna: 50_000n,
      memo: 'vettai:1a2b3c4d',
      onSigned: (hash) => {
        order.push(`signed ${hash}`)
        expect(rpc.pushed).toHaveLength(0)
      },
    })

    order.push(`pushed ${rpc.pushed[0]?.hash}`)

    expect(order).toEqual([`signed ${sent.hash}`, `pushed ${sent.hash}`])
    expect(rpc.pushed[0]).toMatchObject({
      recipient: to,
      sender: OWN_ADDRESS,
      valueLuna: 50_000n,
      memo: 'vettai:1a2b3c4d',
    })
  })

  it('refuses what the chain would refuse, before anything is signed', async () => {
    const rpc = new FakeRpc()
    const paying = sender(rpc)

    await expect(paying.send({ to: 'NQ00 NOT AN ADDRESS', valueLuna: 1n, memo: 'x' })).rejects.toThrow(
      /not a Nimiq address/,
    )
    await expect(paying.send({ to: randomAddress(), valueLuna: 0n, memo: 'x' })).rejects.toThrow(
      /more than nothing/,
    )
    await expect(
      paying.send({ to: randomAddress(), valueLuna: 1n, memo: 'v'.repeat(65) }),
    ).rejects.toThrow(/limit is 64/)
    await expect(paying.send({ to: OWN_ADDRESS, valueLuna: 1n, memo: 'x' })).rejects.toThrow(/own sender/)

    expect(rpc.pushed).toHaveLength(0)
  })

  it('reports the block a payment landed in', async () => {
    const rpc = new FakeRpc()
    rpc.includeAfter = 1
    const paying = sender(rpc)

    const { hash } = await paying.send({ to: randomAddress(), valueLuna: 50_000n, memo: 'vettai:aaaabbbb' })

    expect(await paying.waitInclusion(hash, 2_000)).toEqual({ blockNumber: rpc.head })
  })

  it('tells a hash the node never heard of apart from one it cannot answer about', async () => {
    const rpc = new FakeRpc()
    rpc.includeAfter = 1
    const paying = sender(rpc)

    expect(await paying.lookup(randomHash())).toEqual({ unknown: true })

    const { hash } = await paying.send({ to: randomAddress(), valueLuna: 50_000n, memo: 'vettai:aaaabbbb' })
    expect(await paying.lookup(hash)).toEqual({ unknown: true })
    expect(await paying.lookup(hash)).toEqual({ blockNumber: rpc.head })

    rpc.failLookups = true
    expect(await paying.lookup(hash)).toEqual({ pending: true })
  })

  it('reads a node that cannot answer as still pending, never as a failure', async () => {
    const rpc = new FakeRpc()
    const paying = sender(rpc)

    const { hash } = await paying.send({ to: randomAddress(), valueLuna: 50_000n, memo: 'vettai:aaaabbbb' })
    rpc.failLookups = true

    expect(await paying.waitInclusion(hash, 5)).toEqual({ pending: true })
    expect(rpc.pushed).toHaveLength(1)
  })
})
