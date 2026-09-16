import { Address, type KeyPair } from '@nimiq/core'

/**
 * The one written form of an address the whole server uses: user friendly, no spaces.
 * Nimiq prints addresses in groups of four, and a single stray space is enough to make
 * two copies of the same wallet look like different rows.
 */
export function canonical(addressOrKeyPair: Address | KeyPair): string {
  const address = 'toAddress' in addressOrKeyPair ? addressOrKeyPair.toAddress() : addressOrKeyPair
  return address.toUserFriendlyAddress().replace(/\s+/g, '')
}

/**
 * Turns anything a wallet, a QR code or the chain hands us into the one form the
 * database stores: uppercase, no spaces, checksum proven. Returns null when the string
 * is not a real Nimiq address, so a payout can never be queued to something nobody
 * holds the key for.
 */
export function normalizeAddress(address: unknown): string | null {
  if (typeof address !== 'string') return null

  const stripped = address.replace(/\s+/g, '').toUpperCase()
  if (!/^NQ[0-9A-Z]{34}$/.test(stripped)) return null

  try {
    return canonical(Address.fromUserFriendlyAddress(stripped))
  } catch {
    return null
  }
}

/**
 * The form two addresses are compared in. Normalised when the string is a real address,
 * stripped and uppercased when it is not, so a comparison never silently succeeds on
 * two different pieces of junk and never fails over a space or a lowercase letter.
 */
export function comparableAddress(value: string): string {
  return normalizeAddress(value) ?? value.replace(/\s+/g, '').toUpperCase()
}

/** The way a Nimiq address is written for people: groups of four, separated by spaces. */
export function formatAddress(address: string): string {
  const stripped = address.replace(/\s+/g, '').toUpperCase()
  return stripped.replace(/.{1,4}/g, (group) => `${group} `).trim()
}
