import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  applyWorldEvents,
  questView,
  type PlayerQuestEvent,
  type QuestKind,
  type QuestView,
} from '../domain/quests.js'
import { bumpDaily } from '../domain/stats.js'
import { utcDay } from '../lib/day.js'
import {
  addPlayer,
  applyFire,
  applyMove,
  createRoom,
  DRONE_SPAWN_MS,
  removePlayer,
  step,
  type PlayerCarry,
} from './sim.js'
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
 * How long one target stays shut after an interact the server took. A place is worth
 * touching twice a second at most, and the database write behind it is worth far less.
 */
export const INTERACT_COOLDOWN_MS = 500

/**
 * What a player who drops keeps for this long: being down, a spent shield, a spent fire
 * budget. Without it, leaving and coming back is a free heal and a way to stand up early.
 */
export const CARRY_MS = 90_000

/** How often a socket is pinged, and how many unanswered pings end it. */
export const PING_EVERY_MS = 15_000
export const MISSED_PONGS_ALLOWED = 2

/**
 * A client this far behind on its own socket is not reading. The tick is a few hundred
 * bytes, so 64 KB is a couple of hundred frames of backlog: a phone in a tunnel, not a
 * phone on a slow link.
 */
export const MAX_BUFFERED_BYTES = 64 * 1024

/** Ten minutes without a move, a shot or an interact and the seat goes back to the room. */
export const IDLE_CONNECTION_MS = 600_000

/**
 * Messages per second per connection. The fire budget sits above the simulation's own
 * four shots a second on purpose: the sim refuses the extra shots on the rules, and this
 * only stops a client from spending the server's time asking.
 */
export const MESSAGE_LIMITS = { move: 30, fire: 8, interact: 5, ping: 2 } as const

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

/**
 * The little of a WebSocket the rooms use, so a test can hand in a plain object. `ping`,
 * `terminate` and `bufferedAmount` are what the ws library gives us; they are optional
 * because a test socket that leaves them out simply never gets pinged or cut off.
 */
export type RoomSocket = {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  ping?: () => void
  terminate?: () => void
  bufferedAmount?: number
}

export type PlayerWire = {
  /** The player's handle in this room, never their wallet address. */
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
   * This connection's name on the wire. Everything the room says about this player uses it,
   * so a wallet address never rides out to the other two dozen people in the room.
   */
  handle: string
  /**
   * This connection's own number. A socket hands it back when it closes, so a close that
   * arrives late, after the same wallet has already reconnected, removes nothing.
   */
  connectionId: number
  /**
   * The move number the server has applied for this player, always 0 on a join. A client
   * that dropped and came back reads its counter from here instead of looking itself up in
   * the players list, so its first moves after a reconnect are not replays the server drops.
   */
  youSeq: number
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
  /** The city these rooms run on, so the recorder can build a day's quests on it. */
  map: WorldMap
  join: (
    address: string,
    gear: PlayerGear,
    socket: RoomSocket,
    quests?: readonly QuestView[],
  ) => JoinResult
  /** Without an id this removes whoever is connected. With one it removes only that connection. */
  leave: (address: string, connectionId?: number) => void
  handle: (address: string, message: string) => void
  start: () => void
  stop: () => void
  snapshot: () => { rooms: number; online: number }
  send: (address: string, event: Record<string, unknown>) => boolean
  /**
   * Today's quests as this player's socket should now see them, merged by kind. A parcel
   * that was in this player's hands and is not in the answer is reported to them.
   */
  noteQuests: (address: string, quests: readonly QuestView[]) => void
  /** The socket answered a ping. */
  pong: (address: string) => void
  setGear: (address: string, gear: PlayerGear) => void
  /** Messages this connection has had refused for coming in too fast. */
  dropped: (address: string) => number | null
  roomFor: (address: string) => RoomHandle | null
}

type Room = {
  id: string
  state: RoomState
  members: Set<string>
  /** The name each member goes by on the wire, by wallet. */
  handles: Map<string, string>
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
  handle: string
  socket: RoomSocket
  roomId: string
  counters: Map<MessageKind, { from: number; count: number }>
  malformed: number
  dropped: number
  /** The highest move number applied on this connection. A new socket starts again at 0. */
  lastSeq: number
  /** Today's quests as this socket last saw them, so a useless interact never reaches the db. */
  quests: Map<QuestKind, QuestView>
  /** When the last interact the server took on each target was taken. */
  interacts: Map<string, number>
  /** The last move, shot or interact. A ping is not a sign of life. */
  lastIntentAt: number
  nextPingAt: number
  missedPongs: number
}

/** Two decimals is a centimetre, which is finer than anything a player can see. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

function playerWire(player: PlayerState, seq: number, handle: string): PlayerWire {
  return {
    id: handle,
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

/**
 * True when this pickup or delivery could still move the courier quest along, read off the
 * quests this socket was last told about. A parcel taken at the wrong point, a drop with
 * nothing in hand or a finished quest cannot change a row, so it never becomes a write.
 */
function courierWants(quest: QuestView | undefined, kind: 'pickup' | 'deliver', point: number): boolean {
  if (!quest || quest.state !== 'open' || !quest.route) return false
  if (kind === 'pickup') return quest.route.from === point
  return quest.route.to === point && quest.carrying === true
}

/**
 * Why a parcel this player was carrying is no longer in their hands, or null when nothing
 * was dropped. A delivery leaves the quest done, so only a quest still open counts here:
 * the same day means the parcel went cold, a later day means the UTC day turned under them.
 */
function parcelDropped(before: QuestView | undefined, after: QuestView): 'cold' | 'day' | null {
  if (after.kind !== 'courier' || after.state !== 'open') return null
  if (before?.carrying !== true || after.carrying === true) return null
  return after.day === before.day ? 'cold' : 'day'
}

/** True when this landmark is one the player's open landmarks quest has not counted yet. */
function landmarkWants(quest: QuestView | undefined, index: number): boolean {
  if (!quest || quest.state !== 'open' || !quest.visited) return false
  return quest.visited[index] === false
}

export function createRooms(options: RoomsOptions): Rooms {
  const { map, seed } = options
  const capacity = options.capacity ?? ROOM_CAPACITY
  const tickMs = options.tickMs ?? TICK_MS
  const clock = options.now ?? Date.now
  const log = options.log ?? (() => {})

  const rooms = new Map<string, Room>()
  const connections = new Map<string, Connection>()
  const carries = new Map<string, { at: number; carry: PlayerCarry }>()
  let nextRoom = 0
  let nextConnection = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function frame(payload: Record<string, unknown>): string {
    return JSON.stringify({ v: PROTOCOL_VERSION, ...payload })
  }

  /** Takes a connection out of the world and shuts its socket with a reason. */
  function evict(connection: Connection, code: number, reason: string): void {
    leave(connection.address, connection.id)
    try {
      connection.socket.close(code, reason)
    } catch {
      log('an evicted socket would not close', { address: connection.address, reason })
    }
  }

  function deliverText(connection: Connection, text: string): void {
    // A socket whose buffer has run away is not reading. Writing more only grows the
    // server's own memory, so the connection goes and the client is told to come back.
    if ((connection.socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
      log('closing a socket that cannot keep up', {
        address: connection.address,
        buffered: connection.socket.bufferedAmount,
      })
      evict(connection, 1013, 'too slow')
      return
    }

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
    const state = createRoom(map, `${seed}:${id}`)
    const room: Room = {
      id,
      // The spawn clock starts when the room opens, so the third drone is a spawn interval
      // away rather than one tick away.
      state: { ...state, nextDroneSpawnAt: now + DRONE_SPAWN_MS },
      members: new Set(),
      handles: new Map(),
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

  /**
   * A name for this player inside this room, drawn fresh for every connection. Four random
   * bytes in a room of two dozen will not collide, and the retry means a draw that somehow
   * did is thrown away rather than shared.
   */
  function drawHandle(room: Room): string {
    const taken = new Set(room.handles.values())
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const handle = randomBytes(4).toString('hex')
      if (!taken.has(handle)) return handle
    }
    throw new Error('could not draw a free handle for this room')
  }

  /** The wire name of a player in this room, or null for somebody who has already left. */
  function handleOf(room: Room, address: string): string | null {
    return room.handles.get(address) ?? null
  }

  function livePlayers(room: Room): PlayerWire[] {
    const wires: PlayerWire[] = []
    for (const player of room.state.players.values()) {
      const handle = handleOf(room, player.id)
      if (handle) wires.push(playerWire(player, seqOf(player.id), handle))
    }
    return wires
  }

  function liveDrones(room: Room): DroneWire[] {
    return [...room.state.drones.values()]
      .filter((drone) => drone.state !== 'dead')
      .map(droneWire)
  }

  /** What this wallet left behind a moment ago, or nothing once the carry window has passed. */
  function carryFor(address: string, now: number): PlayerCarry | undefined {
    const kept = carries.get(address)
    if (!kept) return undefined

    carries.delete(address)
    return now - kept.at <= CARRY_MS ? kept.carry : undefined
  }

  function join(
    address: string,
    gear: PlayerGear,
    socket: RoomSocket,
    quests: readonly QuestView[] = [],
  ): JoinResult {
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

    const now = clock()
    const room = roomForJoin()
    room.state = addPlayer(room.state, address, gear, map.spawn, carryFor(address, now))
    room.members.add(address)
    room.emptyAt = null

    const handle = drawHandle(room)
    room.handles.set(address, handle)

    nextConnection += 1
    const connectionId = nextConnection
    connections.set(address, {
      id: connectionId,
      address,
      handle,
      socket,
      roomId: room.id,
      counters: new Map(),
      malformed: 0,
      dropped: 0,
      lastSeq: 0,
      quests: new Map(quests.map((quest) => [quest.kind, quest])),
      interacts: new Map(),
      lastIntentAt: now,
      nextPingAt: now + PING_EVERY_MS,
      missedPongs: 0,
    })

    const player = room.state.players.get(address)
    if (player) room.sent.set(address, signature(playerWire(player, 0, handle)))

    broadcast(room, { t: 'event', kind: 'join', player: handle }, address)
    log('a player joined', { address, room: room.id })

    return {
      room: room.id,
      tick: room.state.tick,
      players: livePlayers(room),
      drones: liveDrones(room),
      handle,
      connectionId,
      youSeq: 0,
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

    const now = clock()
    const player = room.state.players.get(address)
    if (player) {
      // Dropping the socket is not a way to stand up, refill the shield or clear the fire
      // budget: whoever comes back on this wallet inside the window gets it all back.
      carries.set(address, {
        at: now,
        carry: {
          downedUntil: player.downedUntil,
          shield: player.shield,
          recentFires: [...player.recentFires],
          nextShieldAt: player.nextShieldAt,
        },
      })
    }
    for (const [kept, record] of carries) {
      if (now - record.at > CARRY_MS) carries.delete(kept)
    }

    room.state = removePlayer(room.state, address)
    room.members.delete(address)
    room.sent.delete(address)
    if (room.members.size === 0) room.emptyAt = now

    broadcast(room, { t: 'event', kind: 'leave', player: connection.handle })
    room.handles.delete(address)
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

  /**
   * Walking up to a place and pressing the button.
   *
   * Two gates stand before the database. The first is the cooldown: one target may only be
   * taken twice a second, however fast the frames arrive. The second is the player's own
   * quest set as this socket was last told it, so a parcel taken at the wrong point, a
   * landmark already counted or a finished quest is refused here and never becomes a row
   * lock. The quest engine still checks all of it: this only stops the asking.
   */
  function interact(
    connection: Connection,
    room: Room,
    player: PlayerState,
    target: string,
    now: number,
  ): void {
    const taken = connection.interacts.get(target)
    if (taken !== undefined && now - taken < INTERACT_COOLDOWN_MS) return

    if (target === 'office' || target === 'shop') {
      const place = target === 'office' ? map.office : map.shop
      if (distance(player, place) > INTERACT_RANGE) return refuse(connection, 'too far')

      connection.interacts.set(target, now)
      return deliver(connection, { t: 'event', kind: 'interact', target })
    }

    if (target === 'pickup' || target === 'deliver') {
      const point = courierPointAt(map, player)
      if (point === null) return refuse(connection, 'too far')
      if (!courierWants(connection.quests.get('courier'), target, point)) {
        return refuse(connection, 'nothing to do')
      }

      connection.interacts.set(target, now)
      room.questEvents.push({ address: player.id, kind: target, point })
      room.pending.push({ kind: target, player: player.id, point })
      return
    }

    const index = Number(target.slice('landmark:'.length))
    const landmark = map.landmarks[index]
    if (!landmark) return refuse(connection, 'unknown place')
    if (distance(player, landmark) > INTERACT_RANGE) return refuse(connection, 'too far')
    if (!landmarkWants(connection.quests.get('landmarks'), index)) {
      return refuse(connection, 'nothing to do')
    }

    connection.interacts.set(target, now)
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

    connection.lastIntentAt = now

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

    interact(connection, room, player, body.target, now)
  }

  /**
   * The same event with the player named the way the room names them. An event about
   * somebody who has already left has no handle left to use, and it is dropped rather than
   * carrying a wallet address out to everyone in the room.
   */
  function onWire(room: Room, event: TickEvent): TickEvent | null {
    if (event.kind === 'spawn') return event
    // An assist is a private line to the one player who fired the finishing shot. It goes
    // to them alone in the tick below, so it never rides the frame the whole room reads.
    if (event.kind === 'assist') return null

    const handle = handleOf(room, event.player)
    if (!handle) return null
    return { ...event, player: handle }
  }

  /**
   * The health check on every live socket: ping it, cut it off when it has stopped
   * answering, and take back the seat of somebody who has not touched the game in ten
   * minutes. A phone that went into a pocket looks exactly like a script holding a slot.
   */
  function sweepConnections(now: number): void {
    for (const connection of [...connections.values()]) {
      if (now - connection.lastIntentAt >= IDLE_CONNECTION_MS) {
        log('closing an idle connection', { address: connection.address })
        evict(connection, 1000, 'idle')
        continue
      }

      if (now < connection.nextPingAt) continue

      if (connection.missedPongs >= MISSED_PONGS_ALLOWED) {
        log('terminating a socket that stopped answering', { address: connection.address })
        leave(connection.address, connection.id)
        try {
          if (connection.socket.terminate) connection.socket.terminate()
          else connection.socket.close(1001, 'no answer')
        } catch {
          log('a dead socket would not terminate', { address: connection.address })
        }
        continue
      }

      connection.missedPongs += 1
      connection.nextPingAt = now + PING_EVERY_MS
      try {
        connection.socket.ping?.()
      } catch (error) {
        log('could not ping a socket', { address: connection.address, error: String(error) })
      }
    }
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
          const handle = handleOf(room, player.id)
          if (!handle) continue
          const wire = playerWire(player, seqOf(player.id), handle)
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
          events: events.map((event) => onWire(room, event)).filter((event) => event !== null),
        })

        for (const address of [...room.members]) {
          const connection = connections.get(address)
          if (connection) deliverText(connection, state)
        }
      }

      for (const event of events) {
        if (event.kind === 'kill') batch.push({ address: event.player, kind: 'kill' })
        if (event.kind === 'assist') {
          const connection = connections.get(event.player)
          if (connection) deliver(connection, { t: 'event', kind: 'assist', drone: event.drone })
        }
      }
      batch.push(...room.questEvents)
      room.questEvents = []
    }

    sweepConnections(now)

    if (batch.length > 0) options.onEvents?.(batch)
  }

  return {
    map,
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
      carries.clear()
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

    noteQuests(address: string, quests: readonly QuestView[]): void {
      const connection = connections.get(address)
      if (!connection) return
      for (const quest of quests) {
        const before = connection.quests.get(quest.kind)
        connection.quests.set(quest.kind, quest)

        const reason = parcelDropped(before, quest)
        if (reason) deliver(connection, { t: 'event', kind: 'courier-reset', reason })
      }
    },

    pong(address: string): void {
      const connection = connections.get(address)
      if (!connection) return
      connection.missedPongs = 0
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

/**
 * How many kills may wait for a database that is behind. A room of 24 players cannot earn
 * this many in the time a healthy database takes to catch up, so reaching it means the
 * database is gone rather than slow, and holding more would only cost memory.
 */
export const MAX_HELD_KILLS = 500

export type WorldEventWriter = (
  db: Db,
  events: readonly PlayerQuestEvent[],
  now: Date,
  map: WorldMap,
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
 * are waiting the interacts of the next batch are dropped with a line in the log.
 *
 * Kills are never dropped. A kill is the one event a player earned by playing, and losing
 * one silently is a quest that never finishes. They are held instead and ride out with the
 * first batch the chain has room for, still in the order they happened.
 *
 * A batch that lands after the UTC day has turned builds that player a fresh set of quests
 * and sends them the whole thing, because the alternative is a kill written into a day that
 * does not exist and a player who loses everything they do until they reconnect.
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
  let held: PlayerQuestEvent[] = []

  return (events) => {
    if (pending >= MAX_PENDING_BATCHES) {
      const kills = events.filter((event) => event.kind === 'kill')
      const room = Math.max(0, MAX_HELD_KILLS - held.length)
      held = [...held, ...kills.slice(0, room)]
      log('dropped a tick of interacts, the recorder is too far behind', {
        pending,
        dropped: events.length - kills.length,
        heldKills: held.length,
        lostKills: kills.length - room > 0 ? kills.length - room : 0,
      })
      return
    }

    const batch = held.length > 0 ? [...held, ...events] : events
    held = []

    pending += 1
    const now = new Date()

    tail = tail.then(async () => {
      try {
        const changed = await write(db, batch, now, rooms.map)
        for (const row of changed) {
          // A rolled day replaces the whole set, so the fresh rows are what goes out: they
          // already carry whatever this batch changed.
          const views = (row.rolled ?? row.quests).map(questView)
          // The room keeps its own copy, so the next interact is judged against what this
          // player's quests actually say rather than against what the client claims.
          rooms.noteQuests(row.address, views)
          if (row.rolled) rooms.send(row.address, { t: 'event', kind: 'quests-rolled' })
          for (const view of views) {
            rooms.send(row.address, { t: 'event', kind: 'quest', quest: view })
          }
        }

        const kills = batch.filter((event) => event.kind === 'kill').length
        if (kills > 0) await bumpDaily(db, utcDay(now), { kills })
      } catch (error) {
        log('could not write down a tick of events', { error: String(error) })
      } finally {
        pending -= 1
      }
    })
  }
}
