// Covers the boot-time check of the environment. It does NOT cover .env being read off
// disk (the file is loaded once when the module is imported), and it does NOT prove the
// RPC URL answers: a well-formed URL pointing at nothing still passes here.

import { describe, expect, it } from 'vitest'
import {
  isTreasuryProcess,
  parseConfig,
  proxyWarning,
  trustProxy,
  trustedProxies,
  worldBootRefusal,
} from '../src/config.js'

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

  it('reads the edge hops as a whole number and defaults it to none', () => {
    expect(parseConfig(environment()).TRUST_PROXY_EDGE_HOPS).toBe(0)
    expect(parseConfig(environment({ TRUST_PROXY_EDGE_HOPS: '1' })).TRUST_PROXY_EDGE_HOPS).toBe(1)
    expect(() => parseConfig(environment({ TRUST_PROXY_EDGE_HOPS: '-1' }))).toThrow(/EDGE_HOPS/)
    expect(() => parseConfig(environment({ TRUST_PROXY_EDGE_HOPS: 'one' }))).toThrow(/EDGE_HOPS/)
  })
})

describe('trustProxy', () => {
  it('trusts nobody at all when no peer is named', () => {
    expect(trustProxy(undefined, 1)).toBe(false)
    expect(trustProxy('  ', 1)).toBe(false)
  })

  it('checks the peer against the list and then counts the platform hops', () => {
    const trusts = trustProxy('100.64.0.0/10', 1)
    if (trusts === false) throw new Error('a named peer should have given a predicate')

    // Hop 0 is the machine that opened the socket.
    expect(trusts('100.64.0.4', 0)).toBe(true)
    expect(trusts('106.205.47.53', 0)).toBe(false)
    // Hop 1 is the platform's own edge, and hop 2 is already the client.
    expect(trusts('152.233.68.97', 1)).toBe(true)
    expect(trusts('106.205.47.53', 2)).toBe(false)
  })

  it('trusts the peer alone when there is no edge beyond it', () => {
    const trusts = trustProxy('loopback', 0)
    if (trusts === false) throw new Error('a named peer should have given a predicate')

    expect(trusts('127.0.0.1', 0)).toBe(true)
    expect(trusts('152.233.68.97', 1)).toBe(false)
  })
})

describe('proxyWarning', () => {
  it('says so loudly when mainnet is running with nobody trusted', () => {
    const warning = proxyWarning({ NIMIQ_NETWORK: 'MainAlbatross', TRUST_PROXY: undefined })

    expect(warning).toMatch(/TRUST_PROXY/)
    expect(warning).toMatch(/IP_WALLETS_PER_DAY/)
    expect(warning).toMatch(/one household/)
  })

  it('stays quiet on a testnet, and on a mainnet that names its peer', () => {
    expect(proxyWarning({ NIMIQ_NETWORK: 'TestAlbatross', TRUST_PROXY: undefined })).toBeNull()
    expect(proxyWarning({ NIMIQ_NETWORK: 'MainAlbatross', TRUST_PROXY: '100.64.0.0/10' })).toBeNull()
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
