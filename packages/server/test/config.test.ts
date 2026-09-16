// Covers the boot-time check of the environment. It does NOT cover .env being read off
// disk (the file is loaded once when the module is imported), and it does NOT prove the
// RPC URL answers: a well-formed URL pointing at nothing still passes here.

import { describe, expect, it } from 'vitest'
import { isTreasuryProcess, parseConfig, trustedProxies, worldBootRefusal } from '../src/config.js'

const ADDRESS = 'NQ66KBKYVKLD6J8HN23BY7MVPCT27X2DK54R'

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NIMIQ_RPC_URL: 'https://rpc.testnet.nimiqwatch.com',
    NIMIQ_NETWORK: 'TestAlbatross',
    TREASURY_ADDRESS: ADDRESS,
    POOL_TOTAL_NIM: '100',
    DAILY_CAP_NIM: '5',
    ...overrides,
  }
}

describe('parseConfig', () => {
  it('runs without a database url and fills in the defaults', () => {
    const config = parseConfig(environment())

    expect(config.DATABASE_URL).toBeUndefined()
    expect(config.PORT).toBe(8788)
    expect(config.MAP_SEED).toBe('vettai-1')
    expect(config.IP_WALLETS_PER_DAY).toBe(2)
    expect(config.TREASURY_ADDRESS).toBe(ADDRESS)
  })

  it('reads a spaced treasury address into the stored form', () => {
    const config = parseConfig(environment({ TREASURY_ADDRESS: 'nq66 kbky vkld 6j8h n23b y7mv pct2 7x2d k54r' }))

    expect(config.TREASURY_ADDRESS).toBe(ADDRESS)
  })

  it('refuses to boot without the pool and the daily cap', () => {
    expect(() => parseConfig(environment({ POOL_TOTAL_NIM: undefined }))).toThrow(/POOL_TOTAL_NIM/)
    expect(() => parseConfig(environment({ DAILY_CAP_NIM: '' }))).toThrow(/DAILY_CAP_NIM/)
    expect(() => parseConfig(environment({ POOL_TOTAL_NIM: '1.234567' }))).toThrow(/POOL_TOTAL_NIM/)
  })

  it('refuses a network or an address that is not real', () => {
    expect(() => parseConfig(environment({ NIMIQ_NETWORK: 'Testnet' }))).toThrow(/NIMIQ_NETWORK/)
    expect(() => parseConfig(environment({ TREASURY_ADDRESS: '0xabc' }))).toThrow(/TREASURY_ADDRESS/)
    expect(() => parseConfig(environment({ NIMIQ_RPC_URL: 'not a url' }))).toThrow(/NIMIQ_RPC_URL/)
  })

  it('refuses to start the treasury without its key', () => {
    const asTreasury = environment({ VETTAI_PROCESS: 'src/treasury/index.ts' })

    expect(() => parseConfig(asTreasury)).toThrow(/TREASURY_PRIVATE_KEY/)
    expect(parseConfig({ ...asTreasury, TREASURY_PRIVATE_KEY: 'a'.repeat(64) }).TREASURY_PRIVATE_KEY).toBe(
      'a'.repeat(64),
    )
    expect(() => parseConfig({ ...asTreasury, TREASURY_PRIVATE_KEY: 'nothex' })).toThrow(
      /TREASURY_PRIVATE_KEY/,
    )
  })

  it('knows which process it is, from the name it was given or the script it started', () => {
    expect(isTreasuryProcess({}, 'src/index.ts')).toBe(false)
    expect(isTreasuryProcess({ VETTAI_PROCESS: '' }, 'src/index.ts')).toBe(false)
    expect(isTreasuryProcess({ VETTAI_PROCESS: 'src/index.ts' }, 'src/treasury/index.ts')).toBe(false)
    expect(isTreasuryProcess({ VETTAI_PROCESS: 'src/treasury/index.ts' }, '')).toBe(true)
    expect(isTreasuryProcess({}, String.raw`D:\Vettai\packages\server\src\treasury\index.ts`)).toBe(true)
  })

  it('reads TRUST_PROXY as a list of hops, and blank as trusting nobody', () => {
    expect(parseConfig(environment()).TRUST_PROXY).toBeUndefined()
    expect(parseConfig(environment({ TRUST_PROXY: 'uniquelocal' })).TRUST_PROXY).toBe('uniquelocal')

    expect(trustedProxies(undefined)).toBe(false)
    expect(trustedProxies('   ')).toBe(false)
    expect(trustedProxies('loopback')).toEqual(['loopback'])
    expect(trustedProxies('uniquelocal, 10.0.0.0/8 ')).toEqual(['uniquelocal', '10.0.0.0/8'])
  })
})

describe('worldBootRefusal', () => {
  it('refuses to start the world when the treasury key is in its environment', () => {
    const refusal = worldBootRefusal({ TREASURY_PRIVATE_KEY: 'a'.repeat(64) }, {})

    expect(refusal).toMatch(/TREASURY_PRIVATE_KEY/)
    expect(refusal).toMatch(/treasury process/)
  })

  it('lets the world start when the key is nowhere near it', () => {
    expect(worldBootRefusal({ TREASURY_PRIVATE_KEY: undefined }, { VETTAI_PROCESS: '' })).toBeNull()
  })

  it('sends somebody who asked for the treasury to the treasury command', () => {
    const refusal = worldBootRefusal(
      { TREASURY_PRIVATE_KEY: 'a'.repeat(64) },
      { VETTAI_PROCESS: 'src/treasury/index.ts' },
    )

    expect(refusal).toMatch(/npm run treasury/)
  })
})
