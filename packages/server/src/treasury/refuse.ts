import { KeyPair, PrivateKey } from '@nimiq/core'
import { canonical, comparableAddress } from '../lib/address.js'

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
    throw new Error('TREASURY_PRIVATE_KEY has to be 64 hex characters')
  }

  let address: string
  try {
    address = canonical(KeyPair.derive(PrivateKey.fromHex(input.privateKeyHex)))
  } catch (error) {
    throw new Error(`TREASURY_PRIVATE_KEY is not a Nimiq key: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (comparableAddress(address) !== comparableAddress(input.expectedAddress)) {
    throw new Error(
      `TREASURY_PRIVATE_KEY belongs to ${address}, but TREASURY_ADDRESS says ${input.expectedAddress}`,
    )
  }

  const reported = await input.rpc.getNetworkName()
  if (reported !== input.network) {
    throw new Error(`NIMIQ_NETWORK says ${input.network}, but the node is on ${reported}`)
  }

  return { address, network: reported }
}
