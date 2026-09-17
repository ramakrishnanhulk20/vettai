// Covers what happens to a player who is still in the world when the UTC day turns: the
// kill lands on the new day, the room is handed the new day's quests, and the phone is
// told its board was rebuilt. It does NOT cover the rest of the quest engine
// (quests.test.ts does), and it does NOT prove anything about the claim path.

import { KeyPair } from '@nimiq/core'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, DbHandle } from '../src/db/client.js'
import { quests, type Quest } from '../src/db/schema.js'
import {
  applyWorldEvents,
  courierDetail,
  todaysQuests,
  type PlayerQuestEvent,
} from '../src/domain/quests.js'
import { DAY_MS, utcDay } from '../src/lib/day.js'
import { sleep } from '../src/lib/sleep.js'
import { worldMap } from '../src/routes/world.js'
import { createRooms, recordWorldEvents, type Rooms } from '../src/world/rooms.js'
import type { DroneState, Place } from '../src/world/types.js'
import { listenOnAnyPort, signIn, testApp } from './support/api.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'
import { openSocket, type TestClient } from './support/wsClient.js'

const map = worldMap()

/** Ten seconds before midnight, and twenty seconds later on the other side of it. */
const LAST_NIGHT = new Date('2026-09-15T23:59:50Z')
const PAST_MIDNIGHT = new Date('2026-09-16T00:00:10Z')

let handle: DbHandle
let db: Db

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

function byKind(rows: Quest[], kind: string): Quest {
  const row = rows.find((quest) => quest.kind === kind)
  if (!row) throw new Error(`no ${kind} quest`)
  return row
}

async function questsOn(address: string, day: string): Promise<Quest[]> {
  return db
    .select()
    .from(quests)
    .where(and(eq(quests.address, address), eq(quests.day, day)))
}

describe('a kill written after midnight', () => {
  let address: string

  beforeEach(async () => {
    await clearTables(db)
    const player = await insertPlayer(db)
    address = player.address
  })

  it('builds the new day and counts the kill on it, leaving yesterday alone', async () => {
    await todaysQuests(db, address, map, LAST_NIGHT)

    const changed = await applyWorldEvents(db, [{ address, kind: 'kill' }], PAST_MIDNIGHT, map)

    expect(changed).toHaveLength(1)
    expect(changed[0]?.rolled?.map((row) => row.kind).sort()).toEqual([
      'courier',
      'hunt',
      'landmarks',
      'streak',
    ])

    const today = await questsOn(address, '2026-09-16')
    expect(byKind(today, 'hunt').progress).toBe(1)

    const yesterday = await questsOn(address, '2026-09-15')
    expect(byKind(yesterday, 'hunt').progress).toBe(0)
    expect(yesterday).toHaveLength(4)
  })

  it('drops the write when it has no map to build the day from', async () => {
    await todaysQuests(db, address, map, LAST_NIGHT)

    expect(await applyWorldEvents(db, [{ address, kind: 'kill' }], PAST_MIDNIGHT)).toEqual([])
    expect(await questsOn(address, '2026-09-16')).toHaveLength(0)
  })
})

describe('a player who is still online when the day turns', () => {
  let app: FastifyInstance
  let rooms: Rooms
  let record: (events: PlayerQuestEvent[]) => void
  let base: string
  let open: TestClient[]
  let tomorrow: string

  beforeEach(async () => {
    await clearTables(db)
    open = []

    const clock = new Date(Date.now() + DAY_MS)
    tomorrow = utcDay(clock)

    rooms = createRooms({
      map,
      seed: 'dayroll-test',
      capacity: 24,
      tickMs: 50,
      onEvents: (events) => record(events),
    })
    // The world runs on the real clock; only the write is dated a day on, which is exactly
    // what the recorder sees when a player keeps playing through midnight.
    record = recordWorldEvents(db, rooms, {
      apply: (writeDb, events, _now, world) => applyWorldEvents(writeDb, events, clock, world),
    })
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

  async function joinWorld(): Promise<{ address: string; client: TestClient }> {
    const signedIn = await signIn(app, KeyPair.generate())
    const ticket = await app.inject({
      method: 'GET',
      url: '/api/world/ticket',
      headers: signedIn.auth,
    })

    const client = await openSocket(
      `${base}/ws?ticket=${ticket.json<{ ticket: string }>().ticket}`,
    )
    open.push(client)
    await client.waitForKind('welcome')
    return { address: signedIn.address, client }
  }

  /** Puts a wounded drone in front of the player, twenty metres clear of the board. */
  function droneInFrontOf(address: string, id: string): void {
    const room = rooms.roomFor(address)
    const player = room?.state.players.get(address)
    if (!room || !player) throw new Error('that player is not in the world')

    const at = { x: map.office.x, z: map.office.z - 20 }
    const drone: DroneState = {
      id,
      x: at.x,
      y: 1.6,
      z: at.z + 3,
      yaw: 0,
      hp: 1,
      state: 'patrol',
      loop: 0,
      waypoint: 0,
      target: null,
      targetUntil: 0,
      nextFireAt: Date.now() + 60_000,
      deadUntil: 0,
      damage: new Map(),
    }

    const players = new Map(room.state.players)
    players.set(address, { ...player, x: at.x, z: at.z, shield: 3, downedUntil: 0 })
    room.write({ ...room.state, players, drones: new Map([[drone.id, drone]]), bolts: [] })
  }

  function standAt(address: string, place: Place): void {
    const room = rooms.roomFor(address)
    const player = room?.state.players.get(address)
    if (!room || !player) throw new Error('that player is not in the world')

    const players = new Map(room.state.players)
    players.set(address, { ...player, x: place.x, z: place.z })
    room.write({ ...room.state, players })
  }

  it('is told its board was rebuilt, once, and walks the new route from then on', async () => {
    const { address, client } = await joinWorld()
    const yesterday = utcDay(new Date())

    droneInFrontOf(address, 't1')
    client.send({ t: 'fire', seq: 1, yaw: 0, pitch: 0 })

    await client.waitForEvent('quests-rolled')

    const today = await questsOn(address, tomorrow)
    expect(byKind(today, 'hunt').progress).toBe(1)

    // A second kill lands on a day that now exists, so nothing is rebuilt a second time.
    await sleep(300)
    droneInFrontOf(address, 't2')
    client.send({ t: 'fire', seq: 2, yaw: 0, pitch: 0 })
    await client.waitFor((frame) => {
      if (frame.t !== 'event' || frame['kind'] !== 'quest') return false
      const quest = frame['quest'] as { kind: string; progress: number }
      return quest.kind === 'hunt' && quest.progress === 2
    })

    const route = courierDetail(byKind(today, 'courier'))
    if (!route) throw new Error('the new day has no courier route')

    const point = map.courier[route.from]
    if (!point) throw new Error('the courier route names a point the map does not have')

    standAt(address, point)
    client.send({ t: 'interact', target: 'pickup' })

    const carried = await client.waitFor((frame) => {
      if (frame.t !== 'event' || frame['kind'] !== 'quest') return false
      const quest = frame['quest'] as { kind: string; carrying?: boolean }
      return quest.kind === 'courier' && quest.carrying === true
    })
    expect((carried['quest'] as { day: string }).day).toBe(tomorrow)

    // The parcel is on today's row, and the day the player started in is left as it was.
    const before = await questsOn(address, yesterday)
    expect(courierDetail(byKind(before, 'courier'))?.pickedUpAt).toBeNull()
    expect(byKind(before, 'hunt').progress).toBe(0)

    const rolled = client.frames.filter(
      (frame) => frame.t === 'event' && frame['kind'] === 'quests-rolled',
    )
    expect(rolled).toHaveLength(1)
  }, 20_000)
})
