// Covers issuing and spending a challenge against a real database. It does NOT cover
// the wallet signing the message, which verify.test.ts covers, and it does NOT cover
// two processes racing for the same nonce, which the update itself locks.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildChallengeMessage,
  CHALLENGE_TTL_MS,
  consumeChallenge,
  issueChallenge,
  parseChallengeMessage,
} from '../src/domain/challenges.js'
import type { DbHandle } from '../src/db/client.js'
import { clearTables, freshDb } from './support/db.js'

const QUEST_ID = '6f1d5c1e-6d0c-4f7a-9a4e-1f0a1b2c3d4e'
const ORDER_ID = '0b9c8d7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'

let handle: DbHandle

beforeAll(async () => {
  handle = await freshDb()
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(handle.db)
})

describe('issueChallenge', () => {
  it('writes the three message forms the client signs', async () => {
    const login = await issueChallenge(handle.db, 'login', null)
    const claim = await issueChallenge(handle.db, 'claim', QUEST_ID)
    const shop = await issueChallenge(handle.db, 'shop', ORDER_ID)

    expect(login.message).toBe(`vettai-login:${login.nonce}:${login.expiresAt}`)
    expect(claim.message).toBe(`vettai-claim:${QUEST_ID}:${claim.nonce}:${claim.expiresAt}`)
    expect(shop.message).toBe(`vettai-shop:${ORDER_ID}:${shop.nonce}:${shop.expiresAt}`)
    expect(login.expiresAt - Date.now()).toBeLessThanOrEqual(CHALLENGE_TTL_MS)
    expect(parseChallengeMessage(claim.message)).toEqual({
      kind: 'claim',
      nonce: claim.nonce,
      subject: QUEST_ID,
      expiresAt: claim.expiresAt,
    })
  })

  it('refuses a claim or shop challenge with nothing to point at', async () => {
    await expect(issueChallenge(handle.db, 'claim', null)).rejects.toThrow(/has to name what it is for/)
  })
})

describe('consumeChallenge', () => {
  it('spends a login challenge exactly once', async () => {
    const login = await issueChallenge(handle.db, 'login', null)

    expect(await consumeChallenge(handle.db, login.message)).toEqual({
      ok: true,
      kind: 'login',
      subject: null,
    })
    expect(await consumeChallenge(handle.db, login.message)).toEqual({ ok: false, reason: 'nonce used' })
  })

  it('reports what a claim challenge was for', async () => {
    const claim = await issueChallenge(handle.db, 'claim', QUEST_ID)

    expect(await consumeChallenge(handle.db, claim.message)).toEqual({
      ok: true,
      kind: 'claim',
      subject: QUEST_ID,
    })
  })

  it('refuses a challenge past its ten minutes', async () => {
    const issued = new Date()
    const login = await issueChallenge(handle.db, 'login', null, issued)
    const later = new Date(issued.getTime() + CHALLENGE_TTL_MS + 1)

    expect(await consumeChallenge(handle.db, login.message, later)).toEqual({
      ok: false,
      reason: 'nonce expired',
    })
  })

  it('refuses a nonce presented as a different kind or a different subject', async () => {
    const claim = await issueChallenge(handle.db, 'claim', QUEST_ID)

    const asShop = buildChallengeMessage('shop', QUEST_ID, claim.nonce, claim.expiresAt)
    const asOtherQuest = buildChallengeMessage('claim', ORDER_ID, claim.nonce, claim.expiresAt)

    expect(await consumeChallenge(handle.db, asShop)).toEqual({ ok: false, reason: 'nonce unknown' })
    expect(await consumeChallenge(handle.db, asOtherQuest)).toEqual({ ok: false, reason: 'nonce unknown' })
    expect(await consumeChallenge(handle.db, claim.message)).toEqual({
      ok: true,
      kind: 'claim',
      subject: QUEST_ID,
    })
  })

  it('refuses a message that is not a challenge and a nonce nobody issued', async () => {
    expect(await consumeChallenge(handle.db, 'hello')).toEqual({ ok: false, reason: 'malformed message' })
    expect(await consumeChallenge(handle.db, 'vettai-login:short:123')).toEqual({
      ok: false,
      reason: 'malformed message',
    })
    expect(await consumeChallenge(handle.db, `vettai-login:${'a'.repeat(32)}:${Date.now()}`)).toEqual({
      ok: false,
      reason: 'nonce unknown',
    })
  })
})
