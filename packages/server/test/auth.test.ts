// Covers signing in with a wallet signature, the session that comes out of it, and the
// streak curve. It does NOT cover the phone side (nothing here opens a real Nimiq Pay
// dialog), and it does NOT cover a session reaching its thirty-day expiry, since the
// clock is real in these tests.

import { KeyPair } from '@nimiq/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '../src/db/client.js'
import { players, sessions } from '../src/db/schema.js'
import { login, logout, resolveSession } from '../src/domain/auth.js'
import { issueChallenge } from '../src/domain/challenges.js'
import { rewards, streakReward } from '../src/domain/rewards.js'
import { hashToken } from '../src/lib/tokens.js'
import { signWithKeyPair } from '../src/nimiq/verify.js'
import { addressOf, signIn, testApp } from './support/api.js'
import { clearTables, freshDb } from './support/db.js'

let handle: DbHandle
let wallet: KeyPair

beforeAll(async () => {
  handle = await freshDb()
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(handle.db)
  wallet = KeyPair.generate()
})

async function signedChallenge(keyPair: KeyPair = wallet) {
  const challenge = await issueChallenge(handle.db, 'login', null)
  const signed = signWithKeyPair(keyPair, challenge.message)
  return { message: challenge.message, publicKey: signed.publicKeyHex, signature: signed.signatureHex }
}

describe('login', () => {
  it('creates the player and stores only the hash of the token', async () => {
    const input = await signedChallenge()

    const result = await login(handle.db, { ...input, ipHash: 'a'.repeat(64) })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.address).toBe(wallet.toAddress().toUserFriendlyAddress().replace(/\s+/g, ''))
    expect(result.token).toMatch(/^vt1\.[0-9a-f]{64}$/)

    const [player] = await handle.db.select().from(players)
    expect(player?.address).toBe(result.address)
    expect(player?.gear).toEqual({ blaster: 'mk1', skin: 'default', sprint: false })
    expect(player?.lastIpHash).toBe('a'.repeat(64))

    const [stored] = await handle.db.select().from(sessions)
    expect(stored?.tokenHash).toBe(hashToken(result.token))
    expect(JSON.stringify(stored)).not.toContain(result.token)
  })

  it('signs the same wallet in twice without a second player row', async () => {
    await login(handle.db, await signedChallenge())
    await login(handle.db, await signedChallenge())

    expect(await handle.db.select().from(players)).toHaveLength(1)
    expect(await handle.db.select().from(sessions)).toHaveLength(2)
  })

  it('refuses a replay of a challenge that was already spent', async () => {
    const input = await signedChallenge()

    const first = await login(handle.db, input)
    const replay = await login(handle.db, input)

    expect(first.ok).toBe(true)
    expect(replay).toEqual({ ok: false, status: 401, error: 'nonce used' })
    expect(await handle.db.select().from(sessions)).toHaveLength(1)
  })

  it('refuses a signature from another key and leaves the challenge unspent', async () => {
    const input = await signedChallenge()
    const impostor = signWithKeyPair(KeyPair.generate(), input.message)

    const refused = await login(handle.db, { ...input, signature: impostor.signatureHex })

    expect(refused).toEqual({ ok: false, status: 401, error: 'signature does not match message' })
    expect(await handle.db.select().from(players)).toHaveLength(0)

    const second = await login(handle.db, input)
    expect(second.ok).toBe(true)
  })

  it('refuses a message that is not a login challenge', async () => {
    const challenge = await issueChallenge(handle.db, 'claim', '6f1d5c1e-6d0c-4f7a-9a4e-1f0a1b2c3d4e')
    const signed = signWithKeyPair(wallet, challenge.message)

    const refused = await login(handle.db, {
      message: challenge.message,
      publicKey: signed.publicKeyHex,
      signature: signed.signatureHex,
    })

    expect(refused).toEqual({ ok: false, status: 400, error: 'message is not a vettai login challenge' })
  })
})

describe('resolveSession and logout', () => {
  it('resolves a live token and refuses everything else', async () => {
    const result = await login(handle.db, await signedChallenge())
    if (!result.ok) throw new Error(result.error)

    const player = await resolveSession(handle.db, result.token)
    expect(player?.address).toBe(result.address)

    expect(await resolveSession(handle.db, `vt1.${'a'.repeat(64)}`)).toBeNull()
    expect(await resolveSession(handle.db, result.address)).toBeNull()
    expect(await resolveSession(handle.db, hashToken(result.token))).toBeNull()
  })

  it('makes a token useless the moment the player logs out', async () => {
    const result = await login(handle.db, await signedChallenge())
    if (!result.ok) throw new Error(result.error)

    expect(await logout(handle.db, result.token)).toBe(true)
    expect(await resolveSession(handle.db, result.token)).toBeNull()
    expect(await logout(handle.db, result.token)).toBe(false)
  })
})

describe('streakReward', () => {
  it('follows the curve and stops at ten NIM', () => {
    expect(streakReward(1)).toBe(20_000n)
    expect(streakReward(3)).toBe(120_000n)
    expect(streakReward(20)).toBe(970_000n)
    expect(streakReward(21)).toBe(1_000_000n)
    expect(streakReward(50)).toBe(1_000_000n)
  })

  it('refuses a day that is not a real streak day', () => {
    expect(() => streakReward(0)).toThrow(/whole number from 1/)
    expect(() => streakReward(1.5)).toThrow()
  })
})

describe('rewards', () => {
  it('reads the quest payouts as whole luna', () => {
    expect(rewards.hunt).toBe(50_000n)
    expect(rewards.courier).toBe(30_000n)
    expect(rewards.landmarksFirst).toBe(20_000n)
    expect(rewards.landmarksRepeat).toBe(5_000n)
    expect(rewards.ladder).toEqual([200_000n, 100_000n, 50_000n])
  })
})

describe('the auth routes', () => {
  it('signs a wallet in and answers GET /api/me for it', async () => {
    const app = await testApp(handle.db)
    try {
      const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: {} })
      expect(challenge.json<{ message: string }>().message).toMatch(/^vettai-login:[0-9a-f]{32}:\d+$/)

      const signedIn = await signIn(app, wallet)
      expect(signedIn.address).toBe(addressOf(wallet))

      const me = await app.inject({ method: 'GET', url: '/api/me', headers: signedIn.auth })
      expect(me.statusCode).toBe(200)
      expect(me.json<{ address: string; gear: { blaster: string } }>()).toMatchObject({
        address: addressOf(wallet),
        gear: { blaster: 'mk1', skin: 'default' },
      })

      const [player] = await handle.db.select().from(players)
      expect(player?.lastIpHash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await app.close()
    }
  })

  it('refuses a made-up token and drops a real one on logout', async () => {
    const app = await testApp(handle.db)
    try {
      const signedIn = await signIn(app, wallet)

      const invented = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer vt1.${'a'.repeat(64)}` },
      })
      const anonymous = await app.inject({ method: 'GET', url: '/api/me' })
      expect(invented.statusCode).toBe(401)
      expect(invented.json()).toEqual({ error: 'not signed in' })
      expect(anonymous.statusCode).toBe(401)

      const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: signedIn.auth })
      const after = await app.inject({ method: 'GET', url: '/api/me', headers: signedIn.auth })
      expect(out.statusCode).toBe(200)
      expect(after.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })

  it('counts login attempts against the caller, not a header the caller chose', async () => {
    const app = await testApp(handle.db, { rateLimit: { auth: 3 } })
    try {
      const codes: number[] = []
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/challenge',
          payload: {},
          headers: { 'x-forwarded-for': `203.0.113.${attempt}` },
        })
        codes.push(response.statusCode)
      }

      expect(codes).toEqual([200, 200, 200, 429])
    } finally {
      await app.close()
    }
  })

  it('gives two wallets behind one address a budget each', async () => {
    const app = await testApp(handle.db, { rateLimit: { global: 100, session: 3 } })
    try {
      const mine = await signIn(app, wallet)
      const theirs = await signIn(app, KeyPair.generate())

      const codes: number[] = []
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await app.inject({ method: 'GET', url: '/api/me', headers: mine.auth })
        codes.push(response.statusCode)
      }

      // The fourth call on the first session is over its ceiling, and the second session,
      // which came from the same machine, has not spent anything yet.
      const other = await app.inject({ method: 'GET', url: '/api/me', headers: theirs.auth })

      expect(codes).toEqual([200, 200, 200, 429])
      expect(other.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('counts a made-up bearer token against the address it came from', async () => {
    const app = await testApp(handle.db, { rateLimit: { global: 3, session: 1000 } })
    try {
      const codes: number[] = []
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/me',
          // A different invented token every time. If the limiter believed it, the caller
          // would have a fresh budget on demand.
          headers: { authorization: `Bearer vt1.${String(attempt).repeat(64).slice(0, 64)}` },
        })
        codes.push(response.statusCode)
      }

      expect(codes).toEqual([401, 401, 401, 429])
    } finally {
      await app.close()
    }
  })

  it('answers /health without a session', async () => {
    const app = await testApp(handle.db)
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })

      expect(health.statusCode).toBe(200)
      expect(health.json()).toEqual({ ok: true, network: 'TestAlbatross', rooms: 0, online: 0, dailyCapNim: expect.any(String) })
    } finally {
      await app.close()
    }
  })
})

describe('which address a caller is counted as', () => {
  const forwarded = { 'x-forwarded-for': '203.0.113.5, 198.51.100.7' }

  it('ignores a forwarded header when no proxy is trusted', async () => {
    const app = await testApp(handle.db)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/echo-ip',
        headers: forwarded,
        remoteAddress: '127.0.0.1',
      })

      expect(response.json<{ ip: string }>().ip).toBe('127.0.0.1')
    } finally {
      await app.close()
    }
  })

  it('takes the last hop from a proxy it was told to trust, and only from that proxy', async () => {
    vi.stubEnv('TRUST_PROXY', 'loopback')
    vi.resetModules()

    try {
      const { buildApp } = await import('../src/app.js')
      const app = await buildApp({ db: handle.db, logger: false })

      try {
        const throughProxy = await app.inject({
          method: 'GET',
          url: '/api/echo-ip',
          headers: forwarded,
          remoteAddress: '127.0.0.1',
        })
        const spoofer = await app.inject({
          method: 'GET',
          url: '/api/echo-ip',
          headers: forwarded,
          remoteAddress: '203.0.113.9',
        })

        expect(throughProxy.json<{ ip: string }>().ip).toBe('198.51.100.7')
        expect(spoofer.json<{ ip: string }>().ip).toBe('203.0.113.9')
      } finally {
        await app.close()
      }
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  /**
   * What a platform like Railway actually sends: the container's peer is a private address,
   * the edge that appends the true client sits one hop further out, and the caller has put
   * junk of its own at the front of the header.
   */
  const railway = {
    peer: '100.64.0.4',
    client: '106.205.47.53',
    edge: '152.233.68.97',
    headers: { 'x-forwarded-for': '9.9.9.9, 106.205.47.53, 152.233.68.97' },
  }

  async function echoThrough(
    env: Record<string, string>,
    remoteAddress: string,
  ): Promise<{ ip: string; chain: string | null; peer: string | null }> {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.resetModules()

    try {
      const { buildApp } = await import('../src/app.js')
      const app = await buildApp({ db: handle.db, logger: false })
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/api/echo-ip',
          headers: railway.headers,
          remoteAddress,
        })
        return response.json<{ ip: string; chain: string | null; peer: string | null }>()
      } finally {
        await app.close()
      }
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  }

  it('sees past the platform edge to the real client when it is told how many hops it is', async () => {
    const answer = await echoThrough(
      { TRUST_PROXY: '100.64.0.0/10', TRUST_PROXY_EDGE_HOPS: '1' },
      railway.peer,
    )

    expect(answer.ip).toBe(railway.client)
    expect(answer.chain).toBe(railway.headers['x-forwarded-for'])
    expect(answer.peer).toBe(railway.peer)
  })

  it('stops at the edge when it is not told about the extra hop', async () => {
    const answer = await echoThrough({ TRUST_PROXY: '100.64.0.0/10' }, railway.peer)

    expect(answer.ip).toBe(railway.edge)
  })

  it('believes nothing from a peer that is not on the list, however many hops are allowed', async () => {
    const answer = await echoThrough(
      { TRUST_PROXY: '100.64.0.0/10', TRUST_PROXY_EDGE_HOPS: '1' },
      '203.0.113.9',
    )

    expect(answer.ip).toBe('203.0.113.9')
  })
})
