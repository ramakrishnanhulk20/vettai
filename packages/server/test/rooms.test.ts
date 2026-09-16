// Covers the socket passes and the live rooms against a fake socket: where a joining
// player lands, what goes out every tick, and what a badly behaved client is allowed to
// do. It does NOT open a real WebSocket (ws.test.ts does that), and it does NOT touch the
// database, so nothing here proves quest progress; quests.test.ts does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRooms,
  FULL_STATE_EVERY,
  IDLE_ROOM_MS,
  MAX_PENDING_BATCHES,
  MESSAGE_LIMITS,
  PROTOCOL_VERSION,
  recordWorldEvents,
  type Rooms,
} from '../src/world/rooms.js'
import type { Db } from '../src/db/client.js'
import { issueTicket, redeemTicket, TICKET_TTL_MS } from '../src/world/tickets.js'
import { generateMap } from '../src/world/map.js'
import { STARTING_GEAR } from '../src/db/schema.js'
import type { PlayerQuestEvent } from '../src/domain/quests.js'

const map = generateMap('vettai-test')
const ADDRESS = 'NQ66KBKYVKLD6J8HN23BY7MVPCT27X2DK54R'
const OTHER = 'NQ48 4DVG YJ9V 7FRH 6JXN F5TU KFK6 EAEE 9TCX'.replace(/\s+/g, '')

type Frame = Record<string, unknown> & { t: string }

type FakeSocket = {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  frames: Frame[]
  /** The bytes as they went out, for proving the room was serialised once. */
  raw: string[]
  closes: { code?: number | undefined; reason?: string | undefined }[]
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
  return {
    frames,
    raw,
    closes,
    send: (data) => {
      raw.push(data)
      frames.push(JSON.parse(data) as Frame)
    },
    close: (code, reason) => {
      closes.push({ code, reason })
      if (onClose) setTimeout(onClose, 0)
    },
    of: (kind) => frames.filter((frame) => frame.t === kind),
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
    expect(joined.drones).toHaveLength(6)
    expect(rooms.snapshot()).toEqual({ rooms: 1, online: 1 })
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
    rooms.join(OTHER, STARTING_GEAR, second)

    expect(first.of('event').map((frame) => frame['kind'])).toEqual(['join'])
    expect(first.of('event')[0]?.['player']).toBe(OTHER)
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
    expect(states[0]?.['drones']).toHaveLength(6)
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
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 7, dx: 0, dz: 1, yaw: 0 }))
    ticks(1)

    expect(seqIn(socket.of('state')[0])).toEqual({ [ADDRESS]: 7 })
  })

  it('ignores a move that is not newer than the last one it applied', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 5, dx: 0, dz: 1, yaw: 0 }))
    rooms.handle(ADDRESS, message({ t: 'move', seq: 5, dx: 1, dz: 0, yaw: 2 }))
    rooms.handle(ADDRESS, message({ t: 'move', seq: 4, dx: 1, dz: 0, yaw: 2 }))
    ticks(1)

    const player = rooms.roomFor(ADDRESS)?.state.players.get(ADDRESS)
    expect(player?.intent).toEqual({ dx: 0, dz: 1, yaw: 0 })
    expect(player?.x).toBeCloseTo(map.spawn.x, 6)
    expect(seqIn(socket.of('state')[0])).toEqual({ [ADDRESS]: 5 })
  })

  it('reports the seq of a move that went nowhere, and keeps it through the full list', () => {
    const mine = fakeSocket()
    const theirs = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, mine)
    rooms.join(OTHER, STARTING_GEAR, theirs)

    rooms.handle(ADDRESS, message({ t: 'move', seq: 9, dx: 0, dz: 0, yaw: 0 }))
    ticks(FULL_STATE_EVERY)

    expect(seqIn(mine.of('state')[0])).toEqual({ [ADDRESS]: 9 })
    expect(seqIn(mine.of('state').at(-1))).toEqual({ [ADDRESS]: 9, [OTHER]: 0 })
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
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'interact', target: 'pickup' }))
    expect(socket.of('error').map((frame) => frame['code'])).toEqual(['too far'])

    const point = map.courier[3]
    if (!point) throw new Error('the map has no fourth courier point')
    standAt(ADDRESS, point)
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'pickup' }))
    ticks(1)

    expect(events).toEqual([{ address: ADDRESS, kind: 'pickup', point: 3 }])
    expect(tickEvents(socket)).toContainEqual({ kind: 'pickup', player: ADDRESS, point: 3 })
    expect(socket.of('event').some((frame) => frame['kind'] === 'pickup')).toBe(false)
  })

  it('takes a landmark visit only at that landmark', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)

    rooms.handle(ADDRESS, message({ t: 'interact', target: 'landmark:2' }))
    expect(socket.of('error').map((frame) => frame['code'])).toEqual(['too far'])

    standAt(ADDRESS, map.landmarks[2])
    rooms.handle(ADDRESS, message({ t: 'interact', target: 'landmark:2' }))
    ticks(1)

    expect(events).toEqual([{ address: ADDRESS, kind: 'landmark', index: 2 }])
    expect(tickEvents(socket)).toContainEqual({ kind: 'landmark', player: ADDRESS, index: 2 })
  })

  it('confirms the office when the player is standing at it', () => {
    const socket = fakeSocket()
    rooms.join(ADDRESS, STARTING_GEAR, socket)
    standAt(ADDRESS, map.office)

    rooms.handle(ADDRESS, message({ t: 'interact', target: 'office' }))

    expect(socket.of('event').at(-1)).toMatchObject({ kind: 'interact', target: 'office' })
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
})
