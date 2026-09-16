// Covers the two landlord keys in the environment. It does NOT cover what the treasury
// does with them: the stake read and the quest completion are proven in stakes.test.ts.

import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'

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

describe('the landlord keys', () => {
  it('asks for ten NIM of stake and stays switched off until Ram says otherwise', () => {
    const config = parseConfig(environment())

    expect(config.LANDLORD_MIN_NIM).toBe('10')
    expect(config.LANDLORD_ENABLED).toBe(false)
  })

  it('reads a blank key as the default and "true" as on', () => {
    expect(parseConfig(environment({ LANDLORD_ENABLED: 'TRUE ' })).LANDLORD_ENABLED).toBe(true)
    expect(parseConfig(environment({ LANDLORD_ENABLED: '' })).LANDLORD_ENABLED).toBe(false)
    expect(parseConfig(environment({ LANDLORD_MIN_NIM: '' })).LANDLORD_MIN_NIM).toBe('10')
    expect(parseConfig(environment({ LANDLORD_MIN_NIM: '2.5' })).LANDLORD_MIN_NIM).toBe('2.5')
  })

  it('refuses a stake that is not an amount and a flag that is not yes or no', () => {
    expect(() => parseConfig(environment({ LANDLORD_MIN_NIM: 'ten' }))).toThrow(/LANDLORD_MIN_NIM/)
    expect(() => parseConfig(environment({ LANDLORD_ENABLED: 'maybe' }))).toThrow(/LANDLORD_ENABLED/)
  })
})
