// Covers the claim path end to end with real signatures: challenge, sign, queue, and every
// way it can be refused. It does NOT send any NIM (the treasury outbox does that, and
// outbox.test.ts covers it), and it does NOT cover the caps themselves, which are proven
// against the database in claims.test.ts and claims.caps.property.test.ts.

import { KeyPair } from '@nimiq/core'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { dailyCapLuna } from '../src/config.js'
import type { Db, DbHandle } from '../src/db/client.js'
import { claims, quests, type Quest } from '../src/db/schema.js'
import { todaysQuests } from '../src/domain/quests.js'
import { worldMap } from '../src/routes/world.js'
import { signWithKeyPair } from '../src/nimiq/verify.js'
import { addressOf, signIn, testApp, type SignedIn } from './support/api.js'
import { clearTables, freshDb } from './support/db.js'

const map = worldMap()

let handle: DbHandle
let db: Db
let app: FastifyInstance
let wallet: KeyPair
let signedIn: SignedIn

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  wallet = KeyPair.generate()
  app = await testApp(db)
  signedIn = await signIn(app, wallet)
})

afterEach(async () => {
  await app.close()
})

/** A quest of this player's, already finished, which is what a claim needs. */
async function finishedQuest(address: string = signedIn.address): Promise<Quest> {
  const rows = await todaysQuests(db, address, map)
  const hunt = rows.find((quest) => quest.kind === 'hunt')
  if (!hunt) throw new Error('no hunt quest')

  const [done] = await db
    .update(quests)
    .set({ state: 'done', progress: 5, doneAt: new Date() })
    .where(eq(quests.id, hunt.id))
    .returning()

  if (!done) throw new Error('the quest would not finish')
  return done
}

async function challengeFor(quest: Quest, who: SignedIn = signedIn): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/quests/${quest.id}/claim/challenge`,
    headers: who.auth,
    payload: {},
  })

  if (response.statusCode !== 200) throw new Error(`no challenge: ${response.body}`)
  return response.json<{ message: string }>().message
}

function signed(message: string, keyPair: KeyPair = wallet) {
  const proof = signWithKeyPair(keyPair, message)
  return { message, publicKey: proof.publicKeyHex, signature: proof.signatureHex }
}

/**
 * The same database, with the quest update inside a claim made to fail. It is the only way
 * to reach the second half of that transaction from outside, and what it proves is that the
 * claim written in the first half does not survive on its own.
 */
function dbWithABrokenQuestUpdate(real: Db): Db {
  return new Proxy(real, {
    get(target, property, receiver: unknown) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return (run: (tx: unknown) => unknown) =>
        target.transaction(async (tx) => {
          const breaks = new Proxy(tx, {
            get(inner, call, innerReceiver: unknown) {
              if (call === 'update') throw new Error('the quest update fell over')
              return Reflect.get(inner, call, innerReceiver) as unknown
            },
          })
          return run(breaks)
        })
    },
  }) as Db
}

function claim(quest: Quest, payload: unknown, who: SignedIn = signedIn) {
  return app.inject({
    method: 'POST',
    url: `/api/quests/${quest.id}/claim`,
    headers: who.auth,
    payload: payload as Record<string, unknown>,
  })
}

describe('claiming a finished quest', () => {
  it('queues the payout with a memo that names the quest', async () => {
    const quest = await finishedQuest()
    const message = await challengeFor(quest)

    const response = await claim(quest, signed(message))

    const body = response.json<{ state: string; memo: string; amountNim: string; claimId: string }>()
    expect(response.statusCode).toBe(200)
    expect(body.state).toBe('queued')
    expect(body.memo).toBe(`vettai:${quest.id.slice(0, 8)}`)
    expect(body.memo).toMatch(/^vettai:[0-9a-f]{8}$/)
    expect(body.amountNim).toBe('0.5')

    const [row] = await db.select().from(claims).where(eq(claims.id, body.claimId))
    expect(row?.state).toBe('queued')
    expect(row?.address).toBe(addressOf(wallet))
    expect(row?.ipHash).toMatch(/^[0-9a-f]{64}$/)

    const [after] = await db.select().from(quests).where(eq(quests.id, quest.id))
    expect(after?.state).toBe('claimed')
  })

  it('lists the claim for the player who made it', async () => {
    const quest = await finishedQuest()
    await claim(quest, signed(await challengeFor(quest)))

    const response = await app.inject({ method: 'GET', url: '/api/claims', headers: signedIn.auth })

    const body = response.json<{ claims: { questId: string; state: string; amountNim: string }[] }>()
    expect(body.claims).toHaveLength(1)
    expect(body.claims[0]).toMatchObject({ questId: quest.id, state: 'queued', amountNim: '0.5' })
  })

  it('holds the payout when the wallet has had its day', async () => {
    await db.insert(claims).values({
      address: signedIn.address,
      questId: null,
      kind: 'ladder',
      amountLuna: dailyCapLuna,
      state: 'queued',
      memo: 'vettai:ladder:2026-W38',
    })

    const quest = await finishedQuest()
    const response = await claim(quest, signed(await challengeFor(quest)))

    const body = response.json<{ state: string; reason: string }>()
    expect(response.statusCode).toBe(200)
    expect(body).toMatchObject({ state: 'held', reason: 'daily cap' })

    const [after] = await db.select().from(quests).where(eq(quests.id, quest.id))
    expect(after?.state).toBe('claimed')
  })
})

describe('the ways a claim is refused', () => {
  it('refuses a quest that is worth nothing, before the challenge is spent', async () => {
    const quest = await finishedQuest()
    await db.update(quests).set({ rewardLuna: 0n }).where(eq(quests.id, quest.id))
    const message = await challengeFor(quest)

    const response = await claim(quest, signed(message))

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'nothing to claim' })
    expect(await db.select().from(claims)).toHaveLength(0)

    const [after] = await db.select().from(quests).where(eq(quests.id, quest.id))
    expect(after?.state).toBe('done')
  })

  it('leaves neither a claim nor a claimed quest when the transaction cannot finish', async () => {
    const quest = await finishedQuest()
    const message = await challengeFor(quest)

    const broken = await testApp(dbWithABrokenQuestUpdate(db))
    try {
      const response = await broken.inject({
        method: 'POST',
        url: `/api/quests/${quest.id}/claim`,
        headers: signedIn.auth,
        payload: signed(message) as Record<string, unknown>,
      })

      expect(response.statusCode).toBe(500)
    } finally {
      await broken.close()
    }

    expect(await db.select().from(claims)).toHaveLength(0)
    const [after] = await db.select().from(quests).where(eq(quests.id, quest.id))
    expect(after?.state).toBe('done')
  })

  it('refuses a second claim on the same quest', async () => {
    const quest = await finishedQuest()
    const body = signed(await challengeFor(quest))

    const first = await claim(quest, body)
    const replay = await claim(quest, body)

    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toEqual({ error: 'already claimed' })
    expect(await db.select().from(claims)).toHaveLength(1)
  })

  it('refuses a signed message whose nonce has already been spent', async () => {
    const quest = await finishedQuest()
    const body = signed(await challengeFor(quest))
    await claim(quest, body)

    // Put the quest back the way it was before the claim, so the only thing standing
    // between this replay and a second payout is the spent nonce.
    await db.update(quests).set({ state: 'done' }).where(eq(quests.id, quest.id))

    const replay = await claim(quest, body)

    // A spent nonce is a refusal about this claim, not about the session, so it is a 403
    // with a code. A 401 here would make a phone sign its player out over a stale message.
    expect(replay.statusCode).toBe(403)
    expect(replay.json()).toEqual({ error: 'nonce used', code: 'nonce' })
    expect(await db.select().from(claims)).toHaveLength(1)
  })

  it('refuses a signature made by another key', async () => {
    const quest = await finishedQuest()
    const message = await challengeFor(quest)

    const impostor = await claim(quest, signed(message, KeyPair.generate()))

    expect(impostor.statusCode).toBe(403)
    expect(impostor.json()).toEqual({
      error: 'that signature is from another wallet',
      code: 'other_wallet',
    })
    expect(await db.select().from(claims)).toHaveLength(0)
  })

  it('refuses a signature that does not match the message at all', async () => {
    const quest = await finishedQuest()
    const message = await challengeFor(quest)
    const proof = signed(message)

    const flipped = proof.signature.startsWith('a') ? 'b' : 'a'
    const mangled = await claim(quest, { ...proof, signature: flipped + proof.signature.slice(1) })

    expect(mangled.statusCode).toBe(403)
    expect(mangled.json()).toEqual({
      error: 'signature does not match message',
      code: 'bad_signature',
    })
  })

  it('refuses a claim on somebody else the player does not hold', async () => {
    const quest = await finishedQuest()
    const message = await challengeFor(quest)

    const stranger = await signIn(app, KeyPair.generate())
    const stolen = await claim(quest, signed(message), stranger)
    const peeked = await app.inject({
      method: 'POST',
      url: `/api/quests/${quest.id}/claim/challenge`,
      headers: stranger.auth,
      payload: {},
    })

    expect(stolen.statusCode).toBe(404)
    expect(stolen.json()).toEqual({ error: 'no such quest' })
    expect(peeked.statusCode).toBe(404)
  })

  it('refuses a challenge and a claim on a quest that is not finished', async () => {
    const rows = await todaysQuests(db, signedIn.address, map)
    const open = rows.find((quest) => quest.kind === 'courier')
    if (!open) throw new Error('no courier quest')

    const challenge = await app.inject({
      method: 'POST',
      url: `/api/quests/${open.id}/claim/challenge`,
      headers: signedIn.auth,
      payload: {},
    })

    // A quest that is not done has no challenge to sign, so the claim is sent with a
    // message signed for another one and is refused on the quest, not on the message.
    const done = await finishedQuest()
    const attempt = await claim(open, signed(await challengeFor(done)))

    expect(challenge.statusCode).toBe(409)
    expect(challenge.json()).toEqual({ error: 'that quest is not done yet' })
    expect(attempt.statusCode).toBe(403)
    expect(attempt.json()).toEqual({ error: 'that quest is not done yet', code: 'not_claimable' })
  })

  it('refuses a challenge signed for a different quest', async () => {
    const quest = await finishedQuest()
    const other = await db
      .update(quests)
      .set({ state: 'done', doneAt: new Date() })
      .where(and(eq(quests.address, signedIn.address), eq(quests.kind, 'landmarks')))
      .returning()

    const otherQuest = other[0]
    if (!otherQuest) throw new Error('no second quest')

    const message = await challengeFor(otherQuest)
    const response = await claim(quest, signed(message))

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'message is not a claim challenge for this quest',
    })
  })

  it('refuses a caller with no session and a quest id that is not a quest', async () => {
    const quest = await finishedQuest()

    const anonymous = await app.inject({
      method: 'POST',
      url: `/api/quests/${quest.id}/claim`,
      payload: signed(await challengeFor(quest)),
    })
    const nonsense = await app.inject({
      method: 'POST',
      url: '/api/quests/not-a-uuid/claim/challenge',
      headers: signedIn.auth,
      payload: {},
    })

    expect(anonymous.statusCode).toBe(401)
    expect(nonsense.statusCode).toBe(400)
  })
})
