// Covers the reads a phone makes before it plays: the map, the socket ticket and today's
// quests. It does NOT cover claiming a finished quest (claims.api.test.ts) and it does NOT
// open a socket (ws.test.ts).

import { KeyPair } from '@nimiq/core'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { courierDetail, todaysQuests } from '../src/domain/quests.js'
import { redeemTicket } from '../src/world/tickets.js'
import { worldMap } from '../src/routes/world.js'
import { signIn, testApp } from './support/api.js'
import { clearTables, freshDb } from './support/db.js'

let handle: DbHandle
let db: Db
let app: FastifyInstance
let wallet: KeyPair

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
})

afterEach(async () => {
  await app.close()
})

describe('GET /api/world/map', () => {
  it('serves the city with a version and lets a phone cache it for an hour', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/world/map' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('public, max-age=3600')

    const map = response.json<{ version: string; landmarks: unknown[]; courier: unknown[] }>()
    expect(map.version).toMatch(/^\d+-/)
    expect(map.landmarks).toHaveLength(4)
    expect(map.courier).toHaveLength(8)
  })

  it('needs no session, because the city is public', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/world/map' })
    const second = await app.inject({ method: 'GET', url: '/api/world/map' })

    expect(first.body).toBe(second.body)
  })
})

describe('GET /api/world/ticket', () => {
  it('hands a signed-in player a ticket that works once', async () => {
    const signedIn = await signIn(app, wallet)

    const response = await app.inject({
      method: 'GET',
      url: '/api/world/ticket',
      headers: signedIn.auth,
    })

    const { ticket } = response.json<{ ticket: string }>()
    expect(response.statusCode).toBe(200)
    expect(ticket).toMatch(/^vtk1\.[0-9a-f]{48}$/)
    expect(redeemTicket(ticket)).toBe(signedIn.address)
    expect(redeemTicket(ticket)).toBeNull()
  })

  it('refuses a caller with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/world/ticket' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'not signed in' })
  })
})

describe('GET /api/quests/today', () => {
  it('creates the day set on the first call and reads it back on the second', async () => {
    const signedIn = await signIn(app, wallet)

    const first = await app.inject({
      method: 'GET',
      url: '/api/quests/today',
      headers: signedIn.auth,
    })
    const second = await app.inject({
      method: 'GET',
      url: '/api/quests/today',
      headers: signedIn.auth,
    })

    const body = first.json<{ day: string; quests: { id: string; kind: string }[] }>()
    expect(first.statusCode).toBe(200)
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.quests.map((quest) => quest.kind).sort()).toEqual([
      'courier',
      'hunt',
      'landmarks',
      'streak',
    ])
    expect(second.json<{ quests: { id: string }[] }>().quests.map((quest) => quest.id)).toEqual(
      body.quests.map((quest) => quest.id),
    )
  })

  it('reads the courier route out of the detail column', async () => {
    const signedIn = await signIn(app, wallet)
    const map = worldMap()

    const response = await app.inject({
      method: 'GET',
      url: '/api/quests/today',
      headers: signedIn.auth,
    })

    const quests = response.json<{ quests: { kind: string; route?: { from: number; to: number } }[] }>()
    const courier = quests.quests.find((quest) => quest.kind === 'courier')
    const stored = await todaysQuests(db, signedIn.address, map)
    const row = stored.find((quest) => quest.kind === 'courier')

    const detail = row ? courierDetail(row) : null
    expect(courier?.route).toEqual(detail ? { from: detail.from, to: detail.to } : undefined)
    expect(courier?.route?.from).not.toBe(courier?.route?.to)
  })

  it('shows the streak quest as done and priced off the curve', async () => {
    const signedIn = await signIn(app, wallet)

    const response = await app.inject({
      method: 'GET',
      url: '/api/quests/today',
      headers: signedIn.auth,
    })

    const quests = response.json<{ quests: { kind: string; state: string; rewardNim: string }[] }>()
    const streak = quests.quests.find((quest) => quest.kind === 'streak')
    expect(streak).toMatchObject({ state: 'done', rewardNim: '0.2' })
  })

  it('refuses a caller with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/quests/today' })

    expect(response.statusCode).toBe(401)
  })
})
