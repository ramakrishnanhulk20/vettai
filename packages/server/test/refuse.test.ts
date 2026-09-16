// Covers the two checks the treasury runs before it is allowed to spend. It does NOT
// cover the rest of the boot (the database, the migrations and the loops live in
// src/treasury/index.ts), and it does NOT reach a real node.

import { KeyPair, PrivateKey } from '@nimiq/core'
import { describe, expect, it } from 'vitest'
import { assertTreasuryConfig } from '../src/treasury/refuse.js'
import { FakeRpc } from './support/fakeRpc.js'

const KEY_HEX = PrivateKey.generate().toHex()
const ADDRESS = KeyPair.derive(PrivateKey.fromHex(KEY_HEX)).toAddress().toUserFriendlyAddress()

function check(overrides: Partial<Parameters<typeof assertTreasuryConfig>[0]> = {}) {
  return assertTreasuryConfig({
    privateKeyHex: KEY_HEX,
    expectedAddress: ADDRESS.replace(/\s+/g, ''),
    network: 'TestAlbatross',
    rpc: new FakeRpc(),
    ...overrides,
  })
}

describe('assertTreasuryConfig', () => {
  it('lets a matching key, address and node through, spaced address and all', async () => {
    await expect(check()).resolves.toEqual({
      address: ADDRESS.replace(/\s+/g, ''),
      network: 'TestAlbatross',
    })
    await expect(check({ expectedAddress: ADDRESS })).resolves.toMatchObject({ network: 'TestAlbatross' })
  })

  it('refuses a key that pays out of a different wallet', async () => {
    const stranger = KeyPair.generate().toAddress().toUserFriendlyAddress().replace(/\s+/g, '')

    await expect(check({ expectedAddress: stranger })).rejects.toThrow(/TREASURY_ADDRESS says/)
  })

  it('refuses a key that is not a key', async () => {
    await expect(check({ privateKeyHex: 'not-hex' })).rejects.toThrow(/64 hex characters/)
    await expect(check({ privateKeyHex: '' })).rejects.toThrow(/64 hex characters/)
  })

  it('refuses a node that is on the other chain', async () => {
    const rpc = new FakeRpc()
    rpc.network = 'MainAlbatross'

    await expect(check({ rpc })).rejects.toThrow(/the node is on MainAlbatross/)
  })
})
