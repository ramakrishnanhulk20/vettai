// Covers the shape and hashing of session tokens only. It does NOT cover the session
// table or expiry, which auth.test.ts covers, and it does NOT measure the randomness of
// the generator beyond checking that two tokens differ.

import { describe, expect, it } from 'vitest'
import { bearerToken, hashToken, issueSessionToken, parseSessionToken, SESSION_PREFIX } from '../src/lib/tokens.js'

describe('issueSessionToken', () => {
  it('issues a prefixed token that is never the same twice', () => {
    const token = issueSessionToken()
    const second = issueSessionToken()

    expect(token).toMatch(/^vt1\.[0-9a-f]{64}$/)
    expect(token.startsWith(SESSION_PREFIX)).toBe(true)
    expect(second).not.toBe(token)
  })
})

describe('parseSessionToken', () => {
  it('accepts a token it issued', () => {
    const token = issueSessionToken()

    expect(parseSessionToken(token)).toBe(token)
    expect(parseSessionToken(` ${token} `)).toBe(token)
  })

  it('refuses anything that is not a session token', () => {
    expect(parseSessionToken('')).toBeNull()
    expect(parseSessionToken('a'.repeat(64))).toBeNull()
    expect(parseSessionToken('vt1.notHexAtAll')).toBeNull()
    expect(parseSessionToken('vs1.' + 'a'.repeat(64))).toBeNull()
    expect(parseSessionToken('6f1d5c1e-6d0c-4f7a-9a4e-1f0a1b2c3d4e')).toBeNull()
    expect(parseSessionToken(null)).toBeNull()
  })
})

describe('hashToken', () => {
  it('hides the token and stays stable for the same input', () => {
    const token = issueSessionToken()
    const hash = hashToken(token)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(token.slice(SESSION_PREFIX.length))
    expect(hashToken(token)).toBe(hash)
    expect(hashToken(issueSessionToken())).not.toBe(hash)
  })
})

describe('bearerToken', () => {
  it('reads the token out of an authorization header', () => {
    expect(bearerToken('Bearer vt1.abc')).toBe('vt1.abc')
    expect(bearerToken('bearer   vt1.abc  ')).toBe('vt1.abc')
    expect(bearerToken('vt1.abc')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })
})
