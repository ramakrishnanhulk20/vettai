// Covers the NIM to luna conversion only. It does NOT cover what the chain accepts as a
// transaction value, and it does NOT cover display rounding: lunaToNim is exact, so a
// screen that wants two decimals has to do that itself.

import { describe, expect, it } from 'vitest'
import { LUNA_PER_NIM, lunaToNim, nimToLuna } from '../src/lib/luna.js'

describe('nimToLuna', () => {
  it('reads whole and part amounts exactly', () => {
    expect(nimToLuna('1')).toBe(LUNA_PER_NIM)
    expect(nimToLuna('0')).toBe(0n)
    expect(nimToLuna('0.5')).toBe(50_000n)
    expect(nimToLuna('0.00001')).toBe(1n)
    expect(nimToLuna('314.84574')).toBe(31_484_574n)
    expect(nimToLuna(' 2 ')).toBe(200_000n)
    expect(nimToLuna('-1.5')).toBe(-150_000n)
  })

  it('refuses an amount finer than one luna', () => {
    expect(() => nimToLuna('0.000001')).toThrow(/more than 5 decimals/)
    expect(() => nimToLuna('1.123456')).toThrow(/more than 5 decimals/)
  })

  it('refuses anything that is not an amount', () => {
    expect(() => nimToLuna('')).toThrow()
    expect(() => nimToLuna('1e5')).toThrow()
    expect(() => nimToLuna('1,5')).toThrow()
    expect(() => nimToLuna('abc')).toThrow()
    expect(() => nimToLuna('.5')).toThrow()
    expect(() => nimToLuna(5 as unknown as string)).toThrow()
  })
})

describe('lunaToNim', () => {
  it('writes an amount without a trailing zero', () => {
    expect(lunaToNim(100_000n)).toBe('1')
    expect(lunaToNim(0n)).toBe('0')
    expect(lunaToNim(1n)).toBe('0.00001')
    expect(lunaToNim(31_484_574n)).toBe('314.84574')
    expect(lunaToNim(-150_000n)).toBe('-1.5')
  })

  it('survives a round trip in both directions', () => {
    for (const nim of ['0', '0.2', '1', '10', '0.00001', '21000000000', '-3.14159']) {
      expect(lunaToNim(nimToLuna(nim))).toBe(nim)
    }
    for (const luna of [0n, 1n, 20_000n, 123_456_789n, 2_100_000_000_000_000n]) {
      expect(nimToLuna(lunaToNim(luna))).toBe(luna)
    }
  })
})
