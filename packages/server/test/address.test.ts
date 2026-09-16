// Covers the address rules only. It does NOT cover what Nimiq Pay reports on a phone,
// and it does NOT prove an address exists on chain: a well-formed address with a good
// checksum can still be an account nobody ever funded.

import { describe, expect, it } from 'vitest'
import { KeyPair } from '@nimiq/core'
import { formatAddress, normalizeAddress } from '../src/lib/address.js'

const SPACED = 'NQ66 KBKY VKLD 6J8H N23B Y7MV PCT2 7X2D K54R'
const PLAIN = 'NQ66KBKYVKLD6J8HN23BY7MVPCT27X2DK54R'

describe('normalizeAddress', () => {
  it('stores one form whatever the wallet or the chain writes', () => {
    expect(normalizeAddress(SPACED)).toBe(PLAIN)
    expect(normalizeAddress(PLAIN)).toBe(PLAIN)
    expect(normalizeAddress(SPACED.toLowerCase())).toBe(PLAIN)
    expect(normalizeAddress(`  ${SPACED}  `)).toBe(PLAIN)
  })

  it('refuses an address whose checksum does not add up', () => {
    expect(normalizeAddress('NQ67KBKYVKLD6J8HN23BY7MVPCT27X2DK54R')).toBeNull()
  })

  it('refuses anything that is not a Nimiq address', () => {
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress('0x1234567890123456789012345678901234567890')).toBeNull()
    expect(normalizeAddress(`${PLAIN}X`)).toBeNull()
    expect(normalizeAddress(null)).toBeNull()
    expect(normalizeAddress(42)).toBeNull()
  })

  it('accepts a freshly generated address', () => {
    const generated = KeyPair.generate().toAddress().toUserFriendlyAddress()

    expect(normalizeAddress(generated)).toBe(generated.replace(/\s+/g, ''))
  })
})

describe('formatAddress', () => {
  it('writes an address the way a person reads it', () => {
    expect(formatAddress(PLAIN)).toBe(SPACED)
    expect(formatAddress(SPACED)).toBe(SPACED)
  })
})
