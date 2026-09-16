import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  applyWorldEvents,
  questView,
  type PlayerQuestEvent,
  type QuestView,
} from '../domain/quests.js'
import { bumpDaily } from '../domain/stats.js'
import { utcDay } from '../lib/day.js'
import { addPlayer, applyFire, applyMove, createRoom, removePlayer, step } from './sim.js'
import type {
  BoltState,
  DroneState,
  Place,
  PlayerGear,
  PlayerState,
  RoomState,
  SimEvent,
  WorldMap,
} from './types.js'

/**
 * The live world: rooms of up to two dozen players, a tick every 50 ms, and the socket
 * traffic that comes out of it.
 *
 * Nothing a client sends is trusted as fact. A message is an intent, it is counted against
 * a per-connection budget, and the simulation decides what actually happened. Everything a
 * client is told is read back out of the server's own room state.
 */

/** Every frame carries this, so an old client can refuse a world it does not understand. */
export const PROTOCOL_VERSION = 1

export const ROOM_CAPACITY = 24
export const TICK_MS = 50

/** A player who has not moved is left out of `state`, so the whole list is resent now and then. */
export const FULL_STATE_EVERY = 40

/** How long an empty room keeps ticking before it is dropped. */
export const IDLE_ROOM_MS = 30_000

/** Three unreadable frames and the connection goes, because no real client sends any. */
export const MALFORMED_LIMIT = 3

/** How close a player stands to a place before the server accepts an interact there. */
export const INTERACT_RANGE = 2.5

/**
 * Messages per second per connection. The fire budget sits above the simulation's own
 * four shots a second on purpose: the sim refuses the extra shots on the rules, and this
 * only stops a client from spending the server's time asking.
 */
export const MESSAGE_LIMITS = { move: 20, fire: 8, interact: 5, ping: 2 } as const

export type MessageKind = keyof typeof MESSAGE_LIMITS

const RATE_WINDOW_MS = 1000

const finite = z.number().refine((value) => Number.isFinite(value), 'must be a finite number')

const moveMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  t: z.literal('move'),
  seq: finite.optional(),
  dx: finite,
  dz: finite,
  yaw: finite,
})

const fireMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  t: z.literal('fire'),
  seq: finite.optional(),
  yaw: finite,
  pitch: finite,
})

const interactMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  t: z.literal('interact'),
  target: z.union([
    z.literal('office'),
    z.literal('shop'),
    z.literal('pickup'),
    z.literal('deliver'),
    z.string().regex(/^landmark:[0-3]$/),
  ]),
})

const pingMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  t: z.literal('ping'),
  ts: finite,
})

const clientMessage = z.discriminatedUnion('t', [
  moveMessage,
  fireMessage,
  interactMessage,
  pingMessage,
])

/** Only the two calls the rooms makes, so a test can hand in a plain object. */
export type RoomSocket = {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

export type PlayerWire = {
  id: string
  x: number
  z: number
  yaw: number
  shield: number
  downed: boolean
  gear: PlayerGear
  /**
   * The highest move number the server has applied for this player, 0 before any. A phone
   * on a slow link runs ahead of the server, so this tells its client which of its own
   * inputs are already in the world and which ones it still has to replay.
   */
  seq: number
}

export type DroneWire = {
  id: string
  x: number
  y: number
  z: number
  yaw: number
  hp: number
  state: DroneState['state']
}

export type BoltWire = { id: string; x: number; y: number; z: number }

/**
 * What walking up to a place produces. The simulation does not make these, an interact
 * message does, but they belong to the tick they happened in and ride out with it.
 */
export type PlaceEvent =
  | { kind: 'pickup'; player: string; point: number }
  | { kind: 'deliver'; player: string; point: number }
  | { kind: 'landmark'; player: string; index: number }

/** Everything that happened in one tick of one room, in the order it happened. */
export type TickEvent = SimEvent | PlaceEvent

export type JoinResult = {
  room: string
  tick: number
  players: PlayerWire[]
  drones: DroneWire[]
  /**
   * This connection's own number. A socket hands it back when it closes, so a close that
   * arrives late, after the same wallet has already reconnected, removes nothing.
   */
  connectionId: number
}

export type RoomsOptions = {
  map: WorldMap
  seed: string
  capacity?: number
  tickMs?: number
  /** Called once per tick with everything the quest engine needs to write down. */
  onEvents?: (events: PlayerQuestEvent[]) => void
  /** The clock, so a test can drive the world with fake timers. */
  now?: () => number
  log?: (line: string, detail?: Record<string, unknown>) => void
}

/** A room as the tests see it, so one can be posed for a shot without a real drone flying by. */
export type RoomHandle = {
  id: string
  state: RoomState
  write: (next: RoomState) => void
}

export type Rooms = {
  join: (address: string, gear: PlayerGear, socket: RoomSocket) => JoinResult
  /** Without an id this removes whoever is connected. With one it removes only that connection. */
  leave: (address: string, connectionId?: number) => void
  handle: (address: string, message: string) => void
  start: () => void
  stop: () => void
  snapshot: () => { rooms: number; online: number }
  send: (address: string, event: Record<string, unknown>) => boolean
  setGear: (address: string, gear: PlayerGear) => void
  /** Messages this connection has had refused for coming in too fast. */
  dropped: (address: string) => number | null
  roomFor: (address: string) => RoomHandle | null
}

type Room = {
  id: string
  state: RoomState
  members: Set<string>
  lastTickAt: number
  emptyAt: number | null
  ticksSinceFull: number
  sent: Map<string, string>
  pending: TickEvent[]
  questEvents: PlayerQuestEvent[]
}

type Connection = {
  id: number
  address: string
  socket: RoomSocket
  roomId: string
  counters: Map<MessageKind, { from: number; count: number }>
  malformed: number
  dropped: number
  /** The highest move number applied on this connection. A new socket starts again at 0. */
  lastSeq: number
}

/** Two decimals is a centimetre, which is finer than anything a player can see. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

function playerWire(player: PlayerState, seq: number): PlayerWire {
  return {
    id: player.id,
    x: round(player.x),
    z: round(player.z),
    yaw: round(player.yaw),
    shield: player.shield,
    downed: player.downedUntil > 0,
    gear: player.gear,
    seq,
  }
}

function droneWire(drone: DroneState): DroneWire {
  return {
    id: drone.id,
    x: round(drone.x),
    y: round(drone.y),
    z: round(drone.z),
    yaw: round(drone.yaw),
    hp: drone.hp,
    state: drone.state,
  }
}

function boltWire(bolt: BoltState): BoltWire {
  return { id: bolt.id, x: round(bolt.x), y: round(bolt.y), z: round(bolt.z) }
}

function signature(player: PlayerWire): string {
  const gear = `${player.gear.blaster}:${player.gear.skin}:${player.gear.sprint ? 1 : 0}`
  return `${player.x}|${player.z}|${player.yaw}|${player.shield}|${player.downed ? 1 : 0}|${gear}|${player.seq}`
}

function distance(from: Place, to: Place): number {
  return Math.hypot(from.x - to.x, from.z - to.z)
}

/** The courier point the player is standing on, or null when they are not on one. */
function courierPointAt(map: WorldMap, player: PlayerState): number | null {
  for (const [index, point] of map.courier.entries()) {
    if (distance(player, point) <= INTERACT_RANGE) return index
  }
  return null
}

export function createRooms(options: RoomsOptions): Rooms {
  const { map, seed } = options
  const capacity = options.capacity ?? ROOM_CAPACITY
  const tickMs = options.tickMs ?? TICK_MS
  const clock = options.now ?? Date.now
  const log = options.log ?? (() => {})

  const rooms = new Map<string, Room>()
  const connections = new Map<string, Connection>()
  let nextRoom = 0
  let nextConnection = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function frame(payload: Record<string, unknown>): string {
    return JSON.stringify({ v: PROTOCOL_VERSION, ...payload })
  }

  function deliverText(connection: Connection, text: string): void {
    try {
      connection.socket.send(text)
    } catch (error) {
      log('could not write to a socket', { address: connection.address, error: String(error) })
    }
  }

  function deliver(connection: Connection, payload: Record<string, unknown>): void {
    deliverText(connection, frame(payload))
  }

  function broadcast(room: Room, payload: Record<string, unknown>, except?: string): void {
    for (const address of room.members) {
      if (address === except) continue
      const connection = connections.get(address)
      if (connection) deliver(connection, payload)
    }
  }

  function openRoom(): Room {
    nextRoom += 1
    const id = `r${nextRoom}`
    const now = clock()
    const room: Room = {
      id,
      state: createRoom(map, `${seed}:${id}`),
      members: new Set(),
      lastTickAt: now,
      emptyAt: now,
      ticksSinceFull: 0,
      sent: new Map(),
      pending: [],
      questEvents: [],
    }
    rooms.set(id, room)
    return room
  }

  /** The room with the fewest players that still has a seat, or a new one. */
  function roomForJoin(): Room {
    let best: Room | null = null
    for (const room of rooms.values()) {
      if (room.members.size >= capacity) continue
      if (!best || room.members.size < best.members.size) best = room
    }
    return best ?? openRoom()
  }

  /** The move number the server has applied for this player, or 0 when nobody is connected. */
  function seqOf(address: string): number {
    return connections.get(address)?.lastSeq ?? 0
  }

  function livePlayers(room: Room): PlayerWire[] {
    return [...room.state.players.values()].map((player) => playerWire(player, seqOf(player.id)))
  }

  function liveDrones(room: Room): DroneWire[] {
    return [...room.state.drones.values()]
      .filter((drone) => drone.state !== 'dead')
      .map(droneWire)
  }

  function join(address: string, gear: PlayerGear, socket: RoomSocket): JoinResult {
    const previous = connections.get(address)
    if (previous) {
      // One wallet, one body in the world. A reconnect from a phone that dropped its
      // socket has to take the old one's place, not stand next to it.
      leave(address)
      try {
        previous.socket.close(1000, 'replaced')
      } catch {
        log('the replaced socket would not close', { address })
      }
    }

    const room = roomForJoin()
    room.state = addPlayer(room.state, address, gear, map.spawn)
    room.members.add(address)
    room.emptyAt = null

    nextConnection += 1
    const connectionId = nextConnection
    connections.set(address, {
      id: connectionId,
      address,
      socket,
      roomId: room.id,
      counters: new Map(),
      malformed: 0,
      dropped: 0,
      lastSeq: 0,
    })

    const player = room.state.players.get(address)
    if (player) room.sent.set(address, signature(playerWire(player, 0)))

    broadcast(room, { t: 'event', kind: 'join', player: address }, address)
    log('a player joined', { address, room: room.id })

    return {
      room: room.id,
      tick: room.state.tick,
      players: livePlayers(room),
      drones: liveDrones(room),
      connectionId,
    }
  }

  /**
   * Takes a player out of the world. A phone that dropped its socket and came straight back
   * has two sockets for a moment, and the old one's close event can arrive after the new one
   * has joined. That close names the connection it belongs to, and a name that is not the
   * live one is ignored, so a reconnect is never undone by the socket it replaced.
   */
  function leave(address: string, connectionId?: number): void {
    const connection = connections.get(address)
    if (!connection) return
    if (connectionId !== undefined && connection.id !== connectionId) return

    connections.delete(address)
    const room = rooms.get(connection.roomId)
    if (!room) return

    room.state = removePlayer(room.state, address)
    room.members.delete(address)
    room.sent.delete(address)
    if (room.members.size === 0) room.emptyAt = clock()

    broadcast(room, { t: 'event', kind: 'leave', player: address })
    log('a player left', { address, room: room.id, dropped: connection.dropped })
  }

  /** True when this message fits inside the connection's budget for its kind. */
  function allowed(connection: Connection, kind: MessageKind, now: number): boolean {
    const window = connection.counters.get(kind)
    if (!window || now - window.from >= RATE_WINDOW_MS) {
      connection.counters.set(kind, { from: now, count: 1 })
      return true
    }
    if (window.count >= MESSAGE_LIMITS[kind]) {
      connection.dropped += 1
      return false
    }
    window.count += 1
    return true
  }

  function refuse(connection: Connection, code: string): void {
    deliver(connection, { t: 'error', code })
  }

  function malformed(connection: Connection): void {
    connection.malformed += 1
    refuse(connection, 'malformed')
    if (connection.malformed < MALFORMED_LIMIT) return

    log('closing a socket that keeps sending nonsense', { address: connection.address })
    const address = connection.address
    leave(address, connection.id)
    try {
      connection.socket.close(1008, 'malformed')
    } catch {
      log('the closed socket would not close', { address })
    }
  }

  function interact(connection: Connection, room: Room, player: PlayerState, target: string): void {
    if (target === 'office' || target === 'shop') {
      const place = target === 'office' ? map.office : map.shop
      if (distance(player, place) > INTERACT_RANGE) return refuse(connection, 'too far')
      return deliver(connection, { t: 'event', kind: 'interact', target })
    }

    if (target === 'pickup' || target === 'deliver') {
      const point = courierPointAt(map, player)
      if (point === null) return refuse(connection, 'too far')

      room.questEvents.push({ address: player.id, kind: target, point })
      room.pending.push({ kind: target, player: player.id, point })
      return
    }

    const index = Number(target.slice('landmark:'.length))
    const landmark = map.landmarks[index]
    if (!landmark) return refuse(connection, 'unknown place')
    if (distance(player, landmark) > INTERACT_RANGE) return refuse(connection, 'too far')

    room.questEvents.push({ address: player.id, kind: 'landmark', index })
    room.pending.push({ kind: 'landmark', player: player.id, index })
  }

  function handle(address: string, message: string): void {
    const connection = connections.get(address)
    if (!connection) return

    const room = rooms.get(connection.roomId)
    if (!room) return

    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      return malformed(connection)
    }

    const read = clientMessage.safeParse(parsed)
    if (!read.success) return malformed(connection)

    const now = clock()
    const body = read.data
    if (!allowed(connection, body.t, now)) return

    if (body.t === 'ping') {
      return deliver(connection, { t: 'pong', ts: body.ts, serverTs: now })
    }

    const player = room.state.players.get(address)
    if (!player) return

    if (body.t === 'move') {
      // A client that has not been told its move landed sends it again, so the same input can
      // arrive twice and out of order. Anything not newer than the last applied move is an
      // old intent and taking it would drag the player backwards.
      if (body.seq !== undefined) {
        if (body.seq <= connection.lastSeq) return
        connection.lastSeq = body.seq
      }
      room.state = applyMove(room.state, address, { dx: body.dx, dz: body.dz, yaw: body.yaw }, now)
      return
    }

    if (body.t === 'fire') {
      const shot = applyFire(room.state, address, { yaw: body.yaw, pitch: body.pitch }, now, map)
      room.state = shot.room
      room.pending.push(...shot.events)
      return
    }

    interact(connection, room, player, body.target)
  }

  function tick(now: number): void {
    const batch: PlayerQuestEvent[] = []

    for (const room of [...rooms.values()]) {
      if (room.members.size === 0 && room.emptyAt !== null && now - room.emptyAt >= IDLE_ROOM_MS) {
        rooms.delete(room.id)
        log('an empty room stopped', { room: room.id })
        continue
      }

      const dt = Math.max(0, (now - room.lastTickAt) / 1000)
      const result = step(room.state, map, dt, now)
      room.state = result.room
      room.lastTickAt = now

      const events = [...room.pending, ...result.events]
      room.pending = []

      if (room.members.size > 0) {
        room.ticksSinceFull += 1
        const full = room.ticksSinceFull >= FULL_STATE_EVERY
        if (full) room.ticksSinceFull = 0

        const players: PlayerWire[] = []
        for (const player of room.state.players.values()) {
          const wire = playerWire(player, seqOf(player.id))
          const mark = signature(wire)
          if (full || room.sent.get(player.id) !== mark) players.push(wire)
          room.sent.set(player.id, mark)
        }

        // One string for the whole room. Every member is told the same thing, so building
        // the frame once and writing it many times is the difference between a tick that
        // costs one serialisation and one that costs twenty-four.
        const state = frame({
          t: 'state',
          tick: room.state.tick,
          players,
          drones: liveDrones(room),
          bolts: room.state.bolts.map(boltWire),
          events,
        })

        for (const address of room.members) {
          const connection = connections.get(address)
          if (connection) deliverText(connection, state)
        }
      }

      for (const event of events) {
        if (event.kind === 'kill') batch.push({ address: event.player, kind: 'kill' })
      }
      batch.push(...room.questEvents)
      room.questEvents = []
    }

    if (batch.length > 0) options.onEvents?.(batch)
  }

  return {
    join,
    leave,
    handle,

    start(): void {
      if (timer) return
      timer = setInterval(() => {
        try {
          tick(clock())
        } catch (error) {
          log('a tick failed', { error: String(error) })
        }
      }, tickMs)
      // The world is not a reason to keep a process alive on its own.
      timer.unref?.()
    },

    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
      for (const connection of [...connections.values()]) {
        try {
          connection.socket.close(1001, 'server stopping')
        } catch {
          log('a socket would not close on shutdown', { address: connection.address })
        }
      }
      connections.clear()
      rooms.clear()
    },

    snapshot(): { rooms: number; online: number } {
      return { rooms: rooms.size, online: connections.size }
    },

    send(address: string, event: Record<string, unknown>): boolean {
      const connection = connections.get(address)
      if (!connection) return false
      deliver(connection, event)
      return true
    },

    setGear(address: string, gear: PlayerGear): void {
      const connection = connections.get(address)
      const room = connection ? rooms.get(connection.roomId) : undefined
      const player = room?.state.players.get(address)
      if (!room || !player) return

      const players = new Map(room.state.players)
      players.set(address, { ...player, gear })
      room.state = { ...room.state, players }
    },

    dropped(address: string): number | null {
      return connections.get(address)?.dropped ?? null
    },

    roomFor(address: string): RoomHandle | null {
      const connection = connections.get(address)
      const room = connection ? rooms.get(connection.roomId) : undefined
      if (!room) return null

      return {
        id: room.id,
        get state() {
          return room.state
        },
        write(next: RoomState) {
          room.state = next
        },
      }
    },
  }
}

/** How many batches may be waiting on the database before the next one is thrown away. */
export const MAX_PENDING_BATCHES = 20

export type WorldEventWriter = (
  db: Db,
  events: readonly PlayerQuestEvent[],
  now: Date,
) => Promise<Awaited<ReturnType<typeof applyWorldEvents>>>

export type RecorderOptions = {
  log?: (line: string, detail?: Record<string, unknown>) => void
  /** The writer, so a test can hold one batch open and prove the next one waits for it. */
  apply?: WorldEventWriter
}

/**
 * The wiring between a tick's events and the database: quest progress written down, the
 * changed rows pushed back to the one player they belong to, and the day's kill count
 * bumped. The world server and the socket test both use this, so what the test proves is
 * what actually runs.
 *
 * The batches go through one chain, each waiting for the one before it. Ticks are 50 ms
 * apart and a write is not, so without the chain the fifth kill of a hunt could be counted
 * before the fourth and a quest would finish on the wrong event. A database that falls far
 * enough behind is a lost cause rather than a queue worth growing, so once MAX_PENDING_BATCHES
 * are waiting the next batch is dropped with a line in the log instead.
 */
export function recordWorldEvents(
  db: Db,
  rooms: Rooms,
  options: RecorderOptions = {},
): (events: PlayerQuestEvent[]) => void {
  const log = options.log ?? (() => {})
  const write = options.apply ?? applyWorldEvents

  let tail: Promise<void> = Promise.resolve()
  let pending = 0

  return (events) => {
    if (pending >= MAX_PENDING_BATCHES) {
      log('dropped a tick of world events, the recorder is too far behind', { pending })
      return
    }

    pending += 1
    const now = new Date()

    tail = tail.then(async () => {
      try {
        const changed = await write(db, events, now)
        for (const row of changed) {
          for (const quest of row.quests) {
            const view: QuestView = questView(quest)
            rooms.send(row.address, { t: 'event', kind: 'quest', quest: view })
          }
        }

        const kills = events.filter((event) => event.kind === 'kill').length
        if (kills > 0) await bumpDaily(db, utcDay(now), { kills })
      } catch (error) {
        log('could not write down a tick of events', { error: String(error) })
      } finally {
        pending -= 1
      }
    })
  }
}
