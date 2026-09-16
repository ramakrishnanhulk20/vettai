// Covers the play socket against a real Fastify server on a real port with a real
// WebSocket client: the ticket gate, the welcome, movement, the per-connection budgets,
// a kill turning into quest progress, and a reconnect surviving the close of the socket
// it replaced. It does NOT cover the rules of the simulation
// itself (sim.test.ts does), and it does NOT run two rooms at once.

import { KeyPair } from '@nimiq/core'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { quests } from '../src/db/schema.js'
import type { PlayerQuestEvent } from '../src/domain/quests.js'
import { sleep } from '../src/lib/sleep.js'
import { worldMap } from '../src/routes/world.js'
import {
  createRooms,
  MESSAGE_LIMITS,
  recordWorldEvents,
  type Rooms,
} from '../src/world/rooms.js'
import type { DroneState } from '../src/world/types.js'
import { listenOnAnyPort, signIn, testApp } from './support/api.js'
import { clearTables, freshDb } from './support/db.js'
import { openSocket, type TestClient } from './support/wsClient.js'

const map = worldMap()

let handle: DbHandle
let db: Db
let app: FastifyInstance
let rooms: Rooms
let record: (events: PlayerQuestEvent[]) => void
let base: string
let open: TestClient[]

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  open = []

  rooms = createRooms({
    map,
    seed: 'ws-test',
    capacity: 24,
    tickMs: 50,
    onEvents: (events) => record(events),
  })
  record = recordWorldEvents(db, rooms)
  rooms.start()

  app = await testApp(db, { world: { map, rooms } })
  const server = await listenOnAnyPort(app)
  base = server.url.replace('http://', 'ws://')
})

afterEach(async () => {
  for (const client of open) client.close()
  rooms.stop()
  await app.close()
})

type Joined = { address: string; client: TestClient }

async function ticketFor(wallet: KeyPair): Promise<{ address: string; ticket: string }> {
  const signedIn = await signIn(app, wallet)
  const response = await app.inject({
    method: 'GET',
    url: '/api/world/ticket',
    headers: signedIn.auth,
  })

  return { address: signedIn.address, ticket: response.json<{ ticket: string }>().ticket }
}

async function joinWorld(wallet: KeyPair = KeyPair.generate()): Promise<Joined> {
  const { address, ticket } = await ticketFor(wallet)
  const client = await openSocket(`${base}/ws?ticket=${ticket}`)
  open.push(client)
  await client.waitForKind('welcome')
  return { address, client }
}

/** Puts a wounded drone right in front of a player, so one shot is one kill. */
function droneInFrontOf(address: string, id: string): void {
  const room = rooms.roomFor(address)
  if (!room) throw new Error('that player is in no room')

  const player = room.state.players.get(address)
  if (!player) throw new Error('that player is not in the world')

  const drone: DroneState = {
    id,
    x: player.x,
    y: 1.6,
    z: player.z + 3,
    yaw: 0,
    hp: 1,
    state: 'patrol',
    loop: 0,
    waypoint: 0,
    target: null,
    // Far enough ahead that the drone never shoots back inside a test.
    nextFireAt: Date.now() + 60_000,
    deadUntil: 0,
    damage: new Map(),
  }

  const players = new Map(room.state.players)
  players.set(address, { ...player, shield: 3, downedUntil: 0 })

  room.write({ ...room.state, players, drones: new Map([[drone.id, drone]]), bolts: [] })
}

describe('the ticket gate', () => {
  it('refuses an upgrade with a ticket that is not good', async () => {
    await expect(openSocket(`${base}/ws?ticket=vtk1.${'a'.repeat(48)}`)).rejects.toThrow(/401/)
    await expect(openSocket(`${base}/ws`)).rejects.toThrow(/401/)
  })

  it('refuses the same ticket a second time', async () => {
    const { ticket } = await ticketFor(KeyPair.generate())

    const first = await openSocket(`${base}/ws?ticket=${ticket}`)
    open.push(first)

    await expect(openSocket(`${base}/ws?ticket=${ticket}`)).rejects.toThrow(/401/)
  })
})

describe('the welcome', () => {
  it('hands a new player the map version, the drones and the day set of quests', async () => {
    const { address, client } = await joinWorld()

    const welcome = client.frames.find((frame) => frame.t === 'welcome')
    expect(welcome).toMatchObject({ v: 1, you: address, room: 'r1', mapVersion: map.version })
    expect(welcome?.['drones']).toHaveLength(6)
    const joinedPlayers = welcome?.['players'] as { seq: number }[]
    expect(joinedPlayers).toHaveLength(1)
    // Nothing has been sent yet, so the client has no input of its own to replay.
    expect(joinedPlayers[0]?.seq).toBe(0)

    const questKinds = (welcome?.['quests'] as { kind: string }[]).map((quest) => quest.kind)
    expect(questKinds.sort()).toEqual(['courier', 'hunt', 'landmarks', 'streak'])
  })

  it('starts sending the world every tick', async () => {
    const { client } = await joinWorld()

    const state = await client.waitForKind('state')

    expect(state['tick']).toBeGreaterThan(0)
    expect(state['drones']).toBeInstanceOf(Array)
    expect(state['bolts']).toBeInstanceOf(Array)
  })

  it('answers a ping with a pong', async () => {
    const { client } = await joinWorld()

    client.send({ t: 'ping', ts: 4321 })
    const pong = await client.waitForKind('pong')

    expect(pong['ts']).toBe(4321)
    expect(pong['serverTs']).toBeGreaterThan(0)
  })
})

describe('moving', () => {
  it('shows the player somewhere new in the next state', async () => {
    const { address, client } = await joinWorld()

    client.send({ t: 'move', seq: 1, dx: 0, dz: 1, yaw: 0 })

    const moved = await client.waitFor((frame) => {
      if (frame.t !== 'state') return false
      const players = frame['players'] as { id: string; z: number }[]
      return players.some((player) => player.id === address && player.z > map.spawn.z)
    })

    expect(moved['tick']).toBeGreaterThan(0)
  })

  it('drops the moves past twenty in one second', async () => {
    const { address, client } = await joinWorld()

    for (let n = 0; n < MESSAGE_LIMITS.move; n += 1) {
      client.send({ t: 'move', seq: n + 1, dx: 0, dz: 1, yaw: 1 })
    }
    for (let n = 0; n < 10; n += 1) {
      client.send({ t: 'move', seq: 100 + n, dx: 0, dz: 1, yaw: 2 })
    }

    await client.waitForKind('state')
    await sleep(150)

    expect(rooms.dropped(address)).toBe(10)
    expect(rooms.roomFor(address)?.state.players.get(address)?.intent.yaw).toBe(1)
  })

  it('closes a socket after three frames it cannot read', async () => {
    const { client } = await joinWorld()

    client.sendRaw('this is not json')
    client.sendRaw(JSON.stringify({ v: 1, t: 'move', dx: 'north', dz: 0, yaw: 0 }))
    client.sendRaw(JSON.stringify({ v: 2, t: 'ping', ts: 1 }))

    const closed = await client.waitForClose()

    expect(closed.code).toBe(1008)
    expect(rooms.snapshot().online).toBe(0)
  })
})

describe('shooting', () => {
  it('reports a hit, and the fifth kill finishes the hunt for that player alone', async () => {
    const mine = await joinWorld()
    const theirs = await joinWorld()

    for (let kill = 1; kill <= 5; kill += 1) {
      droneInFrontOf(mine.address, `t${kill}`)
      mine.client.send({ t: 'fire', seq: kill, yaw: 0, pitch: 0 })

      // The shot and the kill happen in the same tick, so they ride out on one state frame.
      const inTick = await mine.client.waitForTickEvents('kill')
      expect(inTick.find((event) => event.kind === 'hit')).toMatchObject({
        player: mine.address,
        drone: `t${kill}`,
        damage: 1,
      })
      expect(inTick.find((event) => event.kind === 'kill')).toMatchObject({
        player: mine.address,
        drone: `t${kill}`,
      })

      // The simulation allows four shots a second, so the fifth one has to wait its turn.
      await sleep(300)
    }

    const quest = await mine.client.waitForEvent('quest')
    const row = quest['quest'] as { kind: string; state: string; progress: number }
    expect(row).toMatchObject({ kind: 'hunt', state: 'done', progress: 5 })

    const [stored] = await db
      .select()
      .from(quests)
      .where(and(eq(quests.address, mine.address), eq(quests.kind, 'hunt')))
    expect(stored?.state).toBe('done')

    expect(theirs.client.seenTickEvent('kill')).toBe(true)
    expect(theirs.client.seenEvent('quest')).toBe(false)
  }, 20_000)
})

describe('coming back after a drop', () => {
  it('keeps the new socket in the world when the one it replaced closes', async () => {
    const wallet = KeyPair.generate()
    const first = await joinWorld(wallet)
    const second = await joinWorld(wallet)

    // The world closes the older socket, and that close reaches the server a moment later.
    const closed = await first.client.waitForClose()
    await sleep(300)

    expect(closed.code).toBe(1000)
    expect(rooms.snapshot().online).toBe(1)
    expect(rooms.roomFor(second.address)?.state.players.get(second.address)).toBeDefined()

    const state = await second.client.waitForKind('state')
    expect(state['tick']).toBeGreaterThan(0)
  })
})
