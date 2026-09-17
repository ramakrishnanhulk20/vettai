// Covers the socket passes and the live rooms against a fake socket: where a joining
// player lands, what goes out every tick, what a badly behaved client is allowed to do,
// what a player keeps when they drop and come back, and how a socket that stops reading is
// cut off. It does NOT open a real WebSocket (ws.test.ts does that), and it does NOT touch
// the database, so nothing here proves quest progress; quests.test.ts does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRooms,
  CARRY_MS,
  FULL_STATE_EVERY,
  IDLE_CONNECTION_MS,
  IDLE_ROOM_MS,
  MAX_BUFFERED_BYTES,
  MAX_PENDING_BATCHES,
  MESSAGE_LIMITS,
  PING_EVERY_MS,
  PROTOCOL_VERSION,
  recordWorldEvents,
  type Rooms,
} from '../src/world/rooms.js'
import type { Db } from '../src/db/client.js'
import { issueTicket, redeemTicket, TICKET_TTL_MS } from '../src/world/tickets.js'
import { generateMap } from '../src/world/map.js'
import { INITIAL_DRONES } from '../src/world/sim.js'
import { STARTING_GEAR } from '../src/db/schema.js'
import type { PlayerQuestEvent, QuestView } from '../src/domain/quests.js'

const map = generateMap('vettai-test')
const ADDRESS = 'NQ66KBKYVKLD6J8HN23BY7MVPCT27X2DK54R'
const OTHER = 'NQ48 4DVG YJ9V 7FRH 6JXN F5TU KFK6 EAEE 9TCX'.replace(/\s+/g, '')

type Frame = Record<string, unknown> & { t: string }

type FakeSocket = {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  ping: () => void
  terminate: () => void
  frames: Frame[]
  /** The bytes as they went out, for proving the room was serialised once. */
  raw: string[]
  closes: { code?: number | undefined; reason?: string | undefined }[]
  /** What a real socket reports when the far end has stopped reading. */
  bufferedAmount: number
  pings: number
  terminated: boolean
  of: (kind: string) => Frame[]
}

/**
 * A socket that reports its close the way a real one does: a tick or two later, never in
 * the same breath as the call that closed it.
 */
function fakeSocket(onClose?: () => void): FakeSocket {
  const frames: Frame[] = []
  const raw: string[] = []
  const closes: { code?: number | undefined; reason?: string | undefined }[] = []
  const socket: FakeSocket = {
    frames,
    raw,
    closes,
    bufferedAmount: 0,
    pings: 0,
    terminated: false,
    send: (data) => {
      raw.push(data)
      frames.push(JSON.parse(data) as Frame)
    },
    close: (code, reason) => {
      closes.push({ code, reason })
      if (onClose) setTimeout(onClose, 0)
    },
    ping: () => {
      socket.pings += 1
    },
    terminate: () => {
      socket.terminated = true
    },
    of: (kind) => frames.filter((frame) => frame.t === kind),
  }
  return socket
}

/** Today's courier quest as the socket would have been told it at join. */
function courierQuest(route: { from: number; to: number }, carrying = false): QuestView {
  return {
    id: 'quest-courier',
    kind: 'courier',
    day: '2026-09-15',
    target: 1,
    progress: 0,
    state: 'open',
    rewardLuna: '30000',
    rewardNim: '0.3',
    route,
    carrying,
  }
}

function landmarksQuest(visited: boolean[] = [false, false, false, false]): QuestView {
  return {
    id: 'quest-landmarks',
    kind: 'landmarks',
    day: '2026-09-15',
    target: 4,
    progress: 0,
    state: 'open',
    rewardLuna: '20000',
    rewardNim: '0.2',
    visited,
  }
}

/** Every event the room put on its state frames, oldest first. */
function tickEvents(socket: FakeSocket): { kind: string }[] {
  return socket.of('state').flatMap((frame) => (frame['events'] as { kind: string }[]) ?? [])
}

function message(payload: Record<string, unknown>): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...payload })
}

let rooms: Rooms
let events: PlayerQuestEvent[]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-15T10:00:00Z'))
  events = []
  rooms = createRooms({
    map,
    seed: 'test',
    capacity: 24,
    tickMs: 50,
    onEvents: (batch) => events.push(...batch),
  })
  rooms.start()
})

afterEach(() => {
  rooms.stop()
  vi.useRealTimers()
})

/** Runs the world for a number of ticks, the way the interval would. */
function ticks(count: number): void {
  vi.advanceTimersByTime(count * 50)
}

describe('socket tickets', () => {
  it('spends a ticket once and refuses everything else', () => {
    const ticket = issueTicket(ADDRESS)

    expect(redeemTicket(ticket)).toBe(ADDRESS)
    expect(redeemTicket(ticket)).toBeNull()
    expect(redeemTicket('vtk1.not-a-ticket')).toBeNull()
    expect(redeemTicket(42)).toBeNull()
  })

  it('lets a ticket die after a minute', () => {
    const issuedAt = Date.now()
    const ticket = issueTicket(ADDRESS, issuedAt)

    expect(redeemTicket(ticket, issuedAt + TICKET_TTL_MS + 1)).toBeNull()
  })
})

describe('joining', () => {
  it('puts the first player in a new room with the world already running', () => {
    const socket = fakeSocket()

    const joined = rooms.join(ADDRESS, STARTING_GEAR, socket)

    expect(joined.room).toBe('r1')
    expect(joined.players).toHaveLength(1)
    expect(joined.drones).toHaveLength(INITIAL_DRONES)
    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 1 })
  })

  it('names the player by a handle, never by the wallet, in everything it sends', () => {
    const socket = fakeSocket()

    const joined = rooms.join(ADDRESS, STARTING_GEAR, socket)
    ticks(1)

    expect(joined.handle).toMatch(/^[0-9a-f]{8}$/)
    expect(joined.players.map((player) => player.id)).toEqual([joined.handle])

    const state = socket.of('state')[0]
    expect(JSON.stringify(state)).not.toContain(ADDRESS)

    const second = rooms.join(OTHER, STARTING_GEAR, fakeSocket())
    expect(second.handle).not.toBe(joined.handle)
  })

  it('fills one room to capacity and opens a second for the player after that', () => {
    for (let n = 0; n < 24; n += 1) rooms.join(`NQ${n}`, STARTING_GEAR, fakeSocket())
    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 24 })

    const late = rooms.join('NQLATE', STARTING_GEAR, fakeSocket())

    expect(late.room).toBe('r2')
    expect(rooms.snapshot()).toEqual({ rooms: 2, online: 25 })
  })

  it('sends the room a join and a leave, but never to the player themselves', () => {
    const first = fakeSocket()
    const second = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, first)
    const theirs = rooms.join(OTHER, STARTING_GEAR, second)

    expect(first.of('event').map((frame) => frame['kind'])).toEqual(['join'])
    expect(first.of('event')[0]?.['player']).toBe(theirs.handle)
    expect(second.of('event')).toHaveLength(0)

    rooms.leave(OTHER)
    expect(first.of('event').map((frame) => frame['kind'])).toEqual(['join', 'leave'])
  })

  it('replaces the older socket when one wallet opens a second one', () => {
    const first = fakeSocket()
    const second = fakeSocket()

    rooms.join(ADDRESS, STARTING_GEAR, first)
    rooms.join(ADDRESS, STARTING_GEAR, second)

    expect(first.closes).toEqual([{ code: 1000, reason: 'replaced' }])
    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 1 })
  })

  it('keeps the player when the socket it replaced reports its close late', () => {
    let firstId = 0
    // What routes/ws.ts does: the close names the connection it was given at join.
    const first = fakeSocket(() => {
      rooms.leave(ADDRESS, firstId)
    })
    firstId = rooms.join(ADDRESS, STARTING_GEAR, first).connectionId

    const second = fakeSocket()
    const rejoined = rooms.join(ADDRESS, STARTING_GEAR, second)
    vi.advanceTimersByTime(1)
    ticks(1)

    expect(rejoined.connectionId).not.toBe(firstId)
    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 1 })
    expect(second.of('state')).toHaveLength(1)
    expect(rooms.roomFor(ADDRESS)?.state.players.get(ADDRESS)).toBeDefined()
  })

  it('only lets a connection remove itself, and lets a caller with no id force it', () => {
    const socket = fakeSocket()
    const { connectionId } = rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.leave(ADDRESS, connectionId + 1)
    expect(rooms.snapshot().online).toBe(1)

    rooms.leave(ADDRESS, connectionId)
    expect(rooms.snapshot().online).toBe(0)

    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())
    rooms.leave(ADDRESS)
    expect(rooms.snapshot().online).toBe(0)
  })
})

describe('the tick', () => {
  it('sends the state every tick with every live drone in it', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    ticks(3)

    const states = socket.of('state')
    expect(states).toHaveLength(3)
    expect(states[0]?.['v']).toBe(PROTOCOL_VERSION)
    expect(states[0]?.['drones']).toHaveLength(INITIAL_DRONES)
    expect(Array.isArray(states[0]?.['bolts'])).toBe(true)
  })

  it('serialises the state once and sends the whole room the same string', () => {
    const mine = fakeSocket()
    const theirs = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, mine)
    rooms.join(OTHER, STARTING_GEAR, theirs)

    ticks(1)

    const sentToMe = mine.raw.filter((text) => text.includes('"t":"state"'))
    const sentToThem = theirs.raw.filter((text) => text.includes('"t":"state"'))
    expect(sentToMe).toHaveLength(1)
    expect(sentToThem).toEqual(sentToMe)
  })

  it('reports a player who moved and leaves out one who did not', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 1, dx: 0, dz: 1, yaw: 0 }))
    ticks(1)
    const moved = socket.of('state')[0]?.['players'] as { id: string; z: number }[]
    expect(moved).toHaveLength(1)
    expect(moved[0]?.z).toBeGreaterThan(map.spawn.z)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 2, dx: 0, dz: 0, yaw: 0 }))
    ticks(2)
    const still = socket.of('state').slice(2)
    expect(still.every((frame) => (frame['players'] as unknown[]).length === 0)).toBe(true)
  })

  it('sends the whole player list again every forty ticks', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    // Drones patrol the centre of the city now, so one would shoot the player inside these
    // two seconds and the lost shield bar would be a second frame carrying players. This
    // test is about the resend, so the sky is cleared first.
    const room = rooms.roomFor(ADDRESS)
    if (!room) throw new Error('that player is in no room')
    room.write({ ...room.state, drones: new Map(), bolts: [] })

    ticks(FULL_STATE_EVERY)

    const withPlayers = socket.of('state').filter((frame) => (frame['players'] as unknown[]).length > 0)
    expect(withPlayers).toHaveLength(1)
    expect(socket.of('state')).toHaveLength(FULL_STATE_EVERY)
  })

  it('answers a ping with a pong and the server clock', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'ping', ts: 1234 }))

    expect(socket.of('pong')[0]).toMatchObject({ ts: 1234, serverTs: Date.now() })
  })
})

describe('the move number the server has applied', () => {
  /** The seq of every player named in a frame, by wallet. */
  function seqIn(frame: Frame | undefined): Record<string, number> {
    const players = (frame?.['players'] ?? []) as { id: string; seq: number }[]
    return Object.fromEntries(players.map((player) => [player.id, player.seq]))
  }

  it('names the move it applied for the player who sent it', () => {
    const socket = fakeSocket()
    const joined = rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 7, dx: 0, dz: 1, yaw: 0 }))
    ticks(1)

    expect(seqIn(socket.of('state')[0])).toEqual({ [joined.handle]: 7 })
  })

  it('ignores a move that is not newer than the last one it applied', () => {
    const socket = fakeSocket()
    const joined = rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 5, dx: 0, dz: 1, yaw: 0 }))
    rooms.handle(ADDRESS, message({ t: 'move', seq: 5, dx: 1, dz: 0, yaw: 2 }))
    rooms.handle(ADDRESS, message({ t: 'move', seq: 4, dx: 1, dz: 0, yaw: 2 }))
    ticks(1)

    const player = rooms.roomFor(ADDRESS)?.state.players.get(ADDRESS)
    expect(player?.intent).toEqual({ dx: 0, dz: 1, yaw: 0 })
    expect(player?.x).toBeCloseTo(map.spawn.x, 6)
    expect(seqIn(socket.of('state')[0])).toEqual({ [joined.handle]: 5 })
  })

  it('reports the seq of a move that went nowhere, and keeps it through the full list', () => {
    const mine = fakeSocket()
    const theirs = fakeSocket()
    const joined = rooms.join(ADDRESS, STARTING_GEAR, mine)
    const second = rooms.join(OTHER, STARTING_GEAR, theirs)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 9, dx: 0, dz: 0, yaw: 0 }))
    ticks(FULL_STATE_EVERY)

    expect(seqIn(mine.of('state')[0])).toEqual({ [joined.handle]: 9 })
    expect(seqIn(mine.of('state').at(-1))).toEqual({ [joined.handle]: 9, [second.handle]: 0 })
  })
})

describe('what a connection may send', () => {
  it('drops the moves past twenty in one second and keeps the twentieth', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    for (let n = 0; n < MESSAGE_LIMITS.move; n += 1) {
      rooms.handle(ADDRESS, message({ t: 'move', dx: 0, dz: 1, yaw: 1 }))
    }
    for (let n = 0; n < 10; n += 1) {
      rooms.handle(ADDRESS, message({ t: 'move', dx: 0, dz: 1, yaw: 2 }))
    }
    ticks(1)

    expect(rooms.dropped(ADDRESS)).toBe(10)
    const players = socket.of('state')[0]?.['players'] as { yaw: number }[]
    expect(players[0]?.yaw).toBe(1)
  })

  it('counts each kind of message against its own budget', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    for (let n = 0; n < MESSAGE_LIMITS.ping + 3; n += 1) {
      rooms.handle(ADDRESS, message({ t: 'ping', ts: n }))
    }

    expect(socket.of('pong')).toHaveLength(MESSAGE_LIMITS.ping)
    expect(rooms.dropped(ADDRESS)).toBe(3)
  })

  it('lets the budget refill after a second', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    for (let n = 0; n < MESSAGE_LIMITS.ping; n += 1) {
      rooms.handle(ADDRESS, message({ t: 'ping', ts: n }))
    }
    vi.advanceTimersByTime(1000)
    rooms.handle(ADDRESS, message({ t: 'ping', ts: 99 }))

    expect(socket.of('pong')).toHaveLength(MESSAGE_LIMITS.ping + 1)
    expect(rooms.dropped(ADDRESS)).toBe(0)
  })

  it('closes a socket that sends three frames it cannot read', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, 'not json at all')
    rooms.handle(ADDRESS, JSON.stringify({ v: 1, t: 'move', dx: 'east' }))
    expect(socket.closes).toHaveLength(0)

    rooms.handle(ADDRESS, JSON.stringify({ v: 9, t: 'ping', ts: 1 }))

    expect(socket.closes).toEqual([{ code: 1008, reason: 'malformed' }])
    expect(socket.of('error').map((frame) => frame['code'])).toEqual([
      'malformed',
      'malformed',
      'malformed',
    ])
    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 0 })
  })

  it('ignores anything from a wallet with no connection', () => {
    expect(() => rooms.handle('NQNOBODY', message({ t: 'ping', ts: 1 }))).not.toThrow()
    expect(rooms.dropped('NQNOBODY')).toBeNull()
  })
})

describe('interacting with a place', () => {
  function standAt(address: string, at: { x: number; z: number }): void {
    const room = rooms.roomFor(address)
    if (!room) throw new Error('no room')
    const player = room.state.players.get(address)
    if (!player) throw new Error('no player')
    const players = new Map(room.state.players)
    players.set(address, { ...player, x: at.x, z: at.z })
    room.write({ ...room.state, players })
  }

  it('refuses a pickup from across the map and takes one at the point', () => {
    const socket = fakeSocket()
    const joined = rooms.join(ADDRESS, STARTING_GEAR, socket, [courierQuest({ from: 3, to: 5 })])

    rooms.handle(ADDRESS, message({ t: 'interact', target: 'pickup' }))
    expect(socket.of('error').map((frame) => frame['code'])).toEqual(['too far'])

    const point = map.courier[3]
    if (!point) throw new Error('the map has no fourth courier point')
    standAt(ADDRESS, point)
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'pickup' }))
    ticks(1)

    expect(events).toEqual([{ address: ADDRESS, kind: 'pickup', point: 3 }])
    expect(tickEvents(socket)).toContainEqual({ kind: 'pickup', player: joined.handle, point: 3 })
    expect(socket.of('event').some((frame) => frame['kind'] === 'pickup')).toBe(false)
  })

  it('never lets a pickup at the wrong point reach the quest engine', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket, [courierQuest({ from: 3, to: 5 })])

    const wrong = map.courier[6]
    if (!wrong) throw new Error('the map has no seventh courier point')
    standAt(ADDRESS, wrong)
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'pickup' }))
    ticks(1)

    expect(events).toEqual([])
    expect(tickEvents(socket)).toEqual([])
    expect(socket.of('error').map((frame) => frame['code'])).toEqual(['nothing to do'])
  })

  it('refuses a delivery from a player who is carrying nothing', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket, [courierQuest({ from: 3, to: 5 })])

    const drop = map.courier[5]
    if (!drop) throw new Error('the map has no sixth courier point')
    standAt(ADDRESS, drop)
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'deliver' }))
    ticks(1)

    expect(events).toEqual([])

    // The same delivery, once the quest engine has said the parcel is in hand.
    rooms.noteQuests(ADDRESS, [courierQuest({ from: 3, to: 5 }, true)])
    vi.advanceTimersByTime(600)
    standAt(ADDRESS, drop)
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'deliver' }))
    ticks(1)

    expect(events).toEqual([{ address: ADDRESS, kind: 'deliver', point: 5 }])
  })

  it('takes a landmark visit only at that landmark', () => {
    const socket = fakeSocket()
    const joined = rooms.join(ADDRESS, STARTING_GEAR, socket, [landmarksQuest()])

    rooms.handle(ADDRESS, message({ t: 'interact', target: 'landmark:2' }))
    expect(socket.of('error').map((frame) => frame['code'])).toEqual(['too far'])

    standAt(ADDRESS, map.landmarks[2])
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'landmark:2' }))
    ticks(1)

    expect(events).toEqual([{ address: ADDRESS, kind: 'landmark', index: 2 }])
    expect(tickEvents(socket)).toContainEqual({ kind: 'landmark', player: joined.handle, index: 2 })
  })

  it('drops a visit to a landmark this player has already counted', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket, [landmarksQuest([false, false, true, false])])

    standAt(ADDRESS, map.landmarks[2])
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'landmark:2' }))
    ticks(1)

    expect(events).toEqual([])
    expect(socket.of('error').map((frame) => frame['code'])).toEqual(['nothing to do'])
  })

  it('takes one interact on a target every half second, however fast they arrive', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket, [landmarksQuest()])
    standAt(ADDRESS, map.landmarks[1])

    // Forty over two seconds, which is what a finger held on the button looks like.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      rooms.handle(ADDRESS, message({ t: 'interact', target: 'landmark:1' }))
      vi.advanceTimersByTime(50)
    }

    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThanOrEqual(4)
  })

  it('confirms the office when the player is standing at it', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)
    standAt(ADDRESS, map.office)

    rooms.handle(ADDRESS, message({ t: 'interact', target: 'office' }))

    expect(socket.of('event').at(-1)).toMatchObject({ kind: 'interact', target: 'office' })
  })
})

describe('keeping the sockets honest', () => {
  it('pings a member and terminates the one that never answers', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(socket.pings).toBe(1)

    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(socket.pings).toBe(2)
    expect(socket.terminated).toBe(false)

    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(socket.terminated).toBe(true)
    expect(rooms.snapshot().online).toBe(0)
  })

  it('leaves a member that answers its pings alone', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    for (let round = 0; round < 8; round += 1) {
      vi.advanceTimersByTime(PING_EVERY_MS)
      rooms.pong(ADDRESS)
    }

    expect(socket.pings).toBe(8)
    expect(socket.terminated).toBe(false)
    expect(rooms.snapshot().online).toBe(1)
  })

  it('closes a socket whose buffer has run away, and stops writing to it', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    ticks(1)
    const before = socket.raw.length
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1
    ticks(2)

    expect(socket.closes).toEqual([{ code: 1013, reason: 'too slow' }])
    expect(socket.raw).toHaveLength(before)
    expect(rooms.snapshot().online).toBe(0)
  })

  it('takes back the seat of a connection that has sent nothing for ten minutes', () => {
    const socket = fakeSocket()
    // A slower tick, because ten minutes of fake time is ten minutes of real ticks.
    const quiet = createRooms({ map, seed: 'idle', capacity: 24, tickMs: 1000 })
    quiet.start()

    try {
      quiet.join(ADDRESS, STARTING_GEAR, socket)

      // The socket is alive and answering the whole time. It is simply not playing.
      for (let round = 0; round < IDLE_CONNECTION_MS / PING_EVERY_MS; round += 1) {
        vi.advanceTimersByTime(PING_EVERY_MS)
        quiet.pong(ADDRESS)
      }

      expect(socket.terminated).toBe(false)
      expect(socket.closes).toEqual([{ code: 1000, reason: 'idle' }])
      expect(quiet.snapshot().online).toBe(0)
    } finally {
      quiet.stop()
    }
  })

  it('keeps a connection that is still playing', () => {
    const socket = fakeSocket()
    const quiet = createRooms({ map, seed: 'busy', capacity: 24, tickMs: 1000 })
    quiet.start()

    try {
      quiet.join(ADDRESS, STARTING_GEAR, socket)

      for (let round = 0; round < IDLE_CONNECTION_MS / PING_EVERY_MS; round += 1) {
        vi.advanceTimersByTime(PING_EVERY_MS)
        quiet.pong(ADDRESS)
        quiet.handle(ADDRESS, message({ t: 'move', dx: 0, dz: 1, yaw: 0 }))
      }

      expect(socket.closes).toHaveLength(0)
      expect(quiet.snapshot().online).toBe(1)
    } finally {
      quiet.stop()
    }
  })
})

describe('dropping and coming back', () => {
  function woundAt(address: string, shield: number, downedUntil = 0): void {
    const room = rooms.roomFor(address)
    if (!room) throw new Error('no room')
    const player = room.state.players.get(address)
    if (!player) throw new Error('no player')
    const players = new Map(room.state.players)
    players.set(address, { ...player, shield, downedUntil })
    room.write({ ...room.state, players })
  }

  it('brings a downed player back still down', () => {
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())
    const comesBackUpAt = Date.now() + 3000
    woundAt(ADDRESS, 0, comesBackUpAt)

    rooms.leave(ADDRESS)
    vi.advanceTimersByTime(1000)
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())

    const back = rooms.roomFor(ADDRESS)?.state.players.get(ADDRESS)
    expect(back?.downedUntil).toBe(comesBackUpAt)
    expect(back?.shield).toBe(0)
  })

  it('keeps a spent shield through a reconnect, and hands it back after the window', () => {
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())
    woundAt(ADDRESS, 1)

    rooms.leave(ADDRESS)
    vi.advanceTimersByTime(2000)
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())
    expect(rooms.roomFor(ADDRESS)?.state.players.get(ADDRESS)?.shield).toBe(1)

    woundAt(ADDRESS, 1)
    rooms.leave(ADDRESS)
    vi.advanceTimersByTime(CARRY_MS + 1000)
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())
    expect(rooms.roomFor(ADDRESS)?.state.players.get(ADDRESS)?.shield).toBe(3)
  })
})

describe('the life of a room', () => {
  it('keeps ticking for thirty seconds after the last player leaves, then stops', () => {
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())
    rooms.leave(ADDRESS)

    vi.advanceTimersByTime(IDLE_ROOM_MS - 1000)
    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 0 })

    vi.advanceTimersByTime(2000)
    expect(rooms.snapshot()).toEqual({ rooms: 0, online: 0 })
  })

  it('keeps a room that somebody came back to', () => {
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())
    rooms.leave(ADDRESS)
    vi.advanceTimersByTime(IDLE_ROOM_MS - 1000)
    rooms.join(OTHER, STARTING_GEAR, fakeSocket())

    vi.advanceTimersByTime(IDLE_ROOM_MS)

    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 1 })
  })
})

describe('reaching one player', () => {
  it('sends an event to that player and nobody else', () => {
    const mine = fakeSocket()
    const theirs = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, mine)
    rooms.join(OTHER, STARTING_GEAR, theirs)

    expect(rooms.send(ADDRESS, { t: 'event', kind: 'gear', item: 'sprint' })).toBe(true)
    expect(rooms.send('NQNOBODY', { t: 'event', kind: 'gear' })).toBe(false)

    expect(mine.of('event').some((frame) => frame['kind'] === 'gear')).toBe(true)
    expect(theirs.of('event').some((frame) => frame['kind'] === 'gear')).toBe(false)
  })

  it('puts bought gear on the live player', () => {
    rooms.join(ADDRESS, STARTING_GEAR, fakeSocket())

    rooms.setGear(ADDRESS, { ...STARTING_GEAR, sprint: true })

    expect(rooms.roomFor(ADDRESS)?.state.players.get(ADDRESS)?.gear.sprint).toBe(true)
  })

  it('closes every socket when the world stops', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.stop()

    expect(socket.closes).toEqual([{ code: 1001, reason: 'server stopping' }])
    expect(rooms.snapshot()).toEqual({ rooms: 0, online: 0 })
  })
})

describe('writing a tick down', () => {
  /** A writer that stops on every batch until the test lets it go. */
  function heldWriter() {
    const started: string[][] = []
    const finished: string[][] = []
    const gates: (() => void)[] = []

    return {
      started,
      finished,
      release: (): void => gates.shift()?.(),
      apply: async (_db: Db, batch: readonly PlayerQuestEvent[]) => {
        const addresses = batch.map((event) => event.address)
        started.push(addresses)
        await new Promise<void>((open) => gates.push(open))
        finished.push(addresses)
        return []
      },
    }
  }

  /** Lets every promise that is already settled run, without moving the clock. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  }

  function visit(address: string): PlayerQuestEvent {
    return { address, kind: 'landmark', index: 0 }
  }

  function kill(address: string): PlayerQuestEvent {
    return { address, kind: 'kill' }
  }

  it('writes the batches down in the order they happened, however slow the first one is', async () => {
    const writer = heldWriter()
    const record = recordWorldEvents({} as Db, rooms, { apply: writer.apply })

    record([visit(ADDRESS)])
    record([visit(OTHER)])
    await settle()

    expect(writer.started).toEqual([[ADDRESS]])

    writer.release()
    await settle()
    expect(writer.started).toEqual([[ADDRESS], [OTHER]])

    writer.release()
    await settle()
    expect(writer.finished).toEqual([[ADDRESS], [OTHER]])
  })

  it('drops a batch rather than queueing for ever when the database falls behind', async () => {
    const writer = heldWriter()
    const lines: string[] = []
    const record = recordWorldEvents({} as Db, rooms, {
      apply: writer.apply,
      log: (line) => lines.push(line),
    })

    for (let batch = 0; batch < MAX_PENDING_BATCHES + 5; batch += 1) record([visit(ADDRESS)])
    await settle()

    expect(lines.filter((line) => line.includes('too far behind'))).toHaveLength(5)

    for (let batch = 0; batch < MAX_PENDING_BATCHES; batch += 1) {
      writer.release()
      await settle()
    }
    expect(writer.finished).toHaveLength(MAX_PENDING_BATCHES)

    // The chain is empty again, so the world is heard from once more.
    record([visit(OTHER)])
    await settle()
    expect(writer.started.at(-1)).toEqual([OTHER])
  })

  it('keeps every kill when the chain is over full, and drops only the interacts', async () => {
    const writer = heldWriter()
    const record = recordWorldEvents({} as Db, rooms, { apply: writer.apply })

    for (let batch = 0; batch < MAX_PENDING_BATCHES; batch += 1) record([visit(OTHER)])
    await settle()

    // Five ticks arrive while the chain is full. Each one is a kill and an interact.
    for (let batch = 0; batch < 5; batch += 1) record([kill(ADDRESS), visit(OTHER)])
    await settle()

    for (let batch = 0; batch < MAX_PENDING_BATCHES; batch += 1) {
      writer.release()
      await settle()
    }

    record([visit(OTHER)])
    await settle()

    // The five kills rode out with the next batch the chain had room for. The five
    // interacts that came with them are gone, which is what they are there for.
    expect(writer.started.at(-1)).toEqual([ADDRESS, ADDRESS, ADDRESS, ADDRESS, ADDRESS, OTHER])
  })
})
