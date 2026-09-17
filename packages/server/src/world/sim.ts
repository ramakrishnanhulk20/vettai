import {
  capsuleHitBySphere,
  overlapsBox,
  rayConeNearest,
  segmentHitsBox,
  slideAgainstBoxes,
} from './geometry.js'
import { LOTS_PER_SIDE, OFFICE_SAFE_RADIUS, PATROL_Y, streetCentre } from './map.js'
import { seeded } from './prng.js'
import type {
  BoltState,
  Box,
  DroneState,
  FireIntent,
  MoveIntent,
  PlayerGear,
  PlayerState,
  Place,
  RoomState,
  SimEvent,
  Vec3,
  WorldMap,
} from './types.js'

/**
 * The rules of play, as pure functions. Nothing here reads a clock, a socket or a database:
 * the caller passes `now` and gets a new room and a list of events back. That is what lets
 * a whole match be replayed from a seed and a list of inputs, and what lets the tests prove
 * the rules instead of poking at a running server.
 */

const PLAYER_RADIUS = 0.5
const PLAYER_HEIGHT = 1.8
const EYE_HEIGHT = 1.6
const TORSO_HEIGHT = 1
export const WALK_SPEED = 6
export const SPRINT_SPEED = 7
const MAX_SHIELD = 3
const DOWNED_MS = 3000
const SHIELD_REGEN_MS = 8000
const FIRE_WINDOW_MS = 1000
const FIRE_PER_SECOND = { mk1: 4, mk2: 6 } as const
export const HITSCAN_RANGE = 60
/**
 * The half angle of the aim assist cone: a drone is counted when the aim is within this of
 * it. A thumb on glass cannot hold a narrow line, and at 468 ms of lag the drone has moved
 * by the time the shot arrives, so the cone is wide on purpose.
 */
export const AIM_CONE_DEGREES = 12
const AIM_CONE = (AIM_CONE_DEGREES * Math.PI) / 180

const DRONE_HP = 3
const DRONE_SPEED = 3
const DRONE_ENGAGE_RANGE = 25
/** How long a drone stays angry at the player who shot it before it looks around again. */
const DRONE_ANGER_MS = 6000
/** A drone chases the player who shot it out to the range that player can shoot back from. */
const DRONE_CHASE_RANGE = 60
const DRONE_CIRCLE_RADIUS = 12
const DRONE_FIRE_MS = 2000
const DRONE_WAYPOINT_REACHED = 1.5
const DRONE_WRECK_MS = 2000
export const MAX_DRONES = 12
export const DRONE_SPAWN_MS = 15000

/** How many drones a room is born with. The rest arrive on the spawn clock, like any other. */
export const INITIAL_DRONES = 2

/** How close an engaged drone is allowed to fly to a tower it is circling. */
const DRONE_CLEARANCE = 1

/** Aim assist looks past this many blocked drones before the shot counts as a miss. */
const AIM_CANDIDATES = 3

const BOLT_SPEED = 18
const BOLT_LIFE_MS = 3000
export const BOLT_RADIUS = 0.15

/**
 * A long step would let a fast player cross a wall in one jump, because collision looks at
 * where a body lands and not at the whole path. The server ticks every 50 ms; anything
 * longer than this is treated as this and the world simply runs slow for that moment.
 *
 * The ceiling is 0.1 s because the fastest body in the game covers 7 m/s times 0.1 s, which
 * is 0.7 m, and every footprint is grown by the half metre of the player's own radius on
 * each side, so the thinnest thing in the way is 1.0 m thick to a walker. A 0.7 m step that
 * starts outside one always lands inside it, where the slide catches it. A longer step could
 * put a sprinting player on the far side of a wall with nothing in between to test.
 */
export const MAX_STEP_SECONDS = 0.1

const IDLE: MoveIntent = { dx: 0, dz: 0, yaw: 0 }

/** The footprints never change for a given map, so they are worked out once and kept. */
const footprints = new WeakMap<WorldMap, Box[]>()

function boxesOf(map: WorldMap): Box[] {
  const known = footprints.get(map)
  if (known) return known
  const boxes = map.buildings.map((building) => building.aabb)
  footprints.set(map, boxes)
  return boxes
}

/** True when a building stands between the two points. Roofs are open sky above the height. */
function blockedByBuilding(from: Vec3, to: Vec3, map: WorldMap): boolean {
  for (const building of map.buildings) {
    if (segmentHitsBox(from, to, building.aabb, 0, building.height)) return true
  }
  return false
}

/** Only buildings taller than the patrol height are in a drone's way. Worked out once. */
const towers = new WeakMap<WorldMap, Box[]>()

function towersOf(map: WorldMap): Box[] {
  const known = towers.get(map)
  if (known) return known
  const boxes = map.buildings
    .filter((building) => building.height > PATROL_Y)
    .map((building) => building.aabb)
  towers.set(map, boxes)
  return boxes
}

/** True when a drone at this spot would be inside a tower, keeping a metre of clearance. */
function droneBlocked(map: WorldMap, x: number, z: number): boolean {
  for (const box of towersOf(map)) if (overlapsBox(x, z, box, DRONE_CLEARANCE)) return true
  return false
}

function speedOf(gear: PlayerGear): number {
  return gear.sprint ? SPRINT_SPEED : WALK_SPEED
}

function shotsPerSecond(gear: PlayerGear): number {
  return FIRE_PER_SECOND[gear.blaster] ?? FIRE_PER_SECOND.mk1
}

function horizontal(a: Place, b: Place): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function aimVector(intent: FireIntent): Vec3 {
  const flat = Math.cos(intent.pitch)
  return {
    x: Math.sin(intent.yaw) * flat,
    y: Math.sin(intent.pitch),
    z: Math.cos(intent.yaw) * flat,
  }
}

/** True for anything standing inside the no-fire circle around the quest board. */
function inSafeZone(map: WorldMap, at: Place): boolean {
  return horizontal(at, map.office) <= OFFICE_SAFE_RADIUS
}

function isLive(drone: DroneState): boolean {
  return drone.state !== 'dead' && drone.hp > 0
}

/** Ties go to the lowest id so two players on the same damage always resolve the same way. */
function topDamage(damage: ReadonlyMap<string, number>): string | null {
  let best: string | null = null
  let bestAmount = 0
  for (const [player, amount] of damage) {
    if (amount > bestAmount || (amount === bestAmount && best !== null && player < best)) {
      best = player
      bestAmount = amount
    }
  }
  return best
}

function spawnDrone(
  room: RoomState,
  map: WorldMap,
  now: number,
): { room: RoomState; drone: DroneState | null } {
  const count = room.ids.drone + 1
  const rng = seeded(`${room.seed}:drone:${count}`)
  // The loops are handed out in turn rather than drawn at random, so no loop is ever left
  // empty by a run of unlucky draws. The first drones take the centre loop, which is the
  // last one, because a room is born with two and a player standing at the spawn has to
  // have something to shoot long before the spawn clock has filled the sky.
  const loopIndex =
    count <= INITIAL_DRONES ? map.patrols.length - 1 : (count - 1) % map.patrols.length
  const loop = map.patrols[loopIndex]
  if (!loop || loop.length === 0) return { room, drone: null }

  const index = Math.floor(rng() * loop.length)
  const at = loop[index]
  if (!at) return { room, drone: null }

  const drone: DroneState = {
    id: `d${count}`,
    x: at.x,
    y: PATROL_Y,
    z: at.z,
    yaw: 0,
    hp: DRONE_HP,
    state: 'patrol',
    loop: loopIndex,
    waypoint: (index + 1) % loop.length,
    target: null,
    targetUntil: 0,
    nextFireAt: now + DRONE_FIRE_MS,
    deadUntil: 0,
    damage: new Map(),
  }
  const drones = new Map(room.drones)
  drones.set(drone.id, drone)
  return { room: { ...room, drones, ids: { ...room.ids, drone: count } }, drone }
}

/**
 * A new room with a couple of drones over the centre of the city. The rest arrive on the
 * spawn clock: a room handed its full dozen at birth would let a player leave and rejoin
 * for a fresh batch whenever the sky went quiet.
 */
export function createRoom(map: WorldMap, seed: string, initial: number = INITIAL_DRONES): RoomState {
  let room: RoomState = {
    tick: 0,
    players: new Map(),
    drones: new Map(),
    bolts: [],
    nextDroneSpawnAt: 0,
    ids: { drone: 0, bolt: 0 },
    seed,
  }
  const born = Math.min(Math.max(Math.floor(initial), 0), MAX_DRONES)
  for (let n = 0; n < born; n++) room = spawnDrone(room, map, 0).room
  return room
}

/**
 * What a player keeps when they drop and come back inside the carry window. Leaving is not
 * a way to stand up, refill the shield or clear the fire counter.
 */
export type PlayerCarry = {
  /** The moment they come back up, on the same clock as `now`. Zero means they are up. */
  readonly downedUntil: number
  readonly shield: number
  readonly recentFires: readonly number[]
  /** When the next shield bar was due, so a reconnect does not hand it back at once. */
  readonly nextShieldAt: number
}

/**
 * Put a player in the room. `at` is the map's spawn point; the default is the centre street
 * crossing, which every generated map keeps clear of buildings. `carry` is what a player who
 * dropped a moment ago left behind, and it wins over the fresh state.
 */
export function addPlayer(
  room: RoomState,
  id: string,
  gear: PlayerGear,
  at: Place = { x: streetCentre(LOTS_PER_SIDE / 2), z: streetCentre(LOTS_PER_SIDE / 2) },
  carry?: PlayerCarry,
): RoomState {
  const shield = carry ? Math.min(Math.max(carry.shield, 0), MAX_SHIELD) : MAX_SHIELD
  const player: PlayerState = {
    id,
    x: at.x,
    z: at.z,
    yaw: 0,
    vx: 0,
    vz: 0,
    shield,
    downedUntil: carry?.downedUntil ?? 0,
    lastFireAt: 0,
    recentFires: carry ? [...carry.recentFires] : [],
    nextShieldAt: carry?.nextShieldAt ?? 0,
    lastIntentAt: 0,
    intent: IDLE,
    gear,
  }
  const players = new Map(room.players)
  players.set(id, player)
  return { ...room, players }
}

/** Take a player out and forget the damage they dealt, so no kill is credited to a ghost. */
export function removePlayer(room: RoomState, id: string): RoomState {
  if (!room.players.has(id)) return room
  const players = new Map(room.players)
  players.delete(id)

  const drones = new Map(room.drones)
  for (const [droneId, drone] of drones) {
    if (!drone.damage.has(id) && drone.target !== id) continue
    const damage = new Map(drone.damage)
    damage.delete(id)
    const dropped = drone.target === id
    drones.set(droneId, {
      ...drone,
      damage,
      target: dropped ? null : drone.target,
      targetUntil: dropped ? 0 : drone.targetUntil,
    })
  }
  return { ...room, players, drones }
}

/**
 * Store where a player wants to go. The direction is normalised here, so a client that
 * sends a long vector gains nothing, and the step function is the only place that moves
 * anybody.
 */
export function applyMove(room: RoomState, id: string, intent: MoveIntent, now: number): RoomState {
  const player = room.players.get(id)
  if (!player) return room

  const length = Math.hypot(intent.dx, intent.dz)
  const usable = Number.isFinite(length) && length > 1e-6
  const stored: MoveIntent = {
    dx: usable ? intent.dx / length : 0,
    dz: usable ? intent.dz / length : 0,
    yaw: Number.isFinite(intent.yaw) ? intent.yaw : player.yaw,
  }
  const players = new Map(room.players)
  players.set(id, { ...player, intent: stored, lastIntentAt: now })
  return { ...room, players }
}

function damageDrone(
  room: RoomState,
  drone: DroneState,
  player: string,
  amount: number,
  now: number,
): { room: RoomState; events: SimEvent[] } {
  const damage = new Map(drone.damage)
  damage.set(player, (damage.get(player) ?? 0) + amount)
  const hp = drone.hp - amount

  const events: SimEvent[] = [
    { kind: 'hit', player, drone: drone.id, damage: amount, x: drone.x, y: drone.y, z: drone.z },
  ]
  // Being shot is what makes a drone yours. It turns on the shooter wherever the shot came
  // from, holds on to them for six seconds, and answers inside its own fire interval, so a
  // player cannot stand at 40 m and take one apart while it flies its loop. A shot can never
  // come from the board's circle, because applyFire refuses one.
  const provokes = room.players.has(player)
  let hurt: DroneState = {
    ...drone,
    hp: hp > 0 ? hp : 0,
    damage,
    state: provokes ? 'engage' : drone.state,
    target: provokes ? player : drone.target,
    targetUntil: provokes ? now + DRONE_ANGER_MS : drone.targetUntil,
    nextFireAt: provokes ? Math.min(drone.nextFireAt, now + DRONE_FIRE_MS) : drone.nextFireAt,
  }
  if (hp <= 0) {
    hurt = { ...hurt, state: 'dead', target: null, targetUntil: 0, deadUntil: now + DRONE_WRECK_MS }
    const credit = topDamage(damage)
    if (credit !== null) {
      events.push({
        kind: 'kill',
        player: credit,
        drone: drone.id,
        x: drone.x,
        y: drone.y,
        z: drone.z,
      })
    }
  }
  const drones = new Map(room.drones)
  drones.set(drone.id, hurt)
  return { room: { ...room, drones }, events }
}

/**
 * Fire the blaster. The rate cap is a sliding one second window, so no second anywhere on
 * the clock can hold more than four shots (six with the mk2). A refused shot changes
 * nothing and reports nothing.
 *
 * The shot is a hitscan from the player's eye out to 60 m, with aim assist: the nearest live
 * drone inside a 12 degree cone around the aim takes one point of damage. A drone with a
 * building between it and the player is skipped, and the next one in the cone is tried, so
 * aim assist can never shoot somebody through a wall.
 *
 * A player standing in the board's circle cannot fire at all. The circle cuts both ways:
 * nothing may shoot into it, so anybody allowed to shoot out of it would be taking drones
 * apart from the one place in the city that cannot answer.
 */
export function applyFire(
  room: RoomState,
  id: string,
  intent: FireIntent,
  now: number,
  map: WorldMap,
): { room: RoomState; events: SimEvent[] } {
  const player = room.players.get(id)
  if (!player || player.downedUntil > 0) return { room, events: [] }
  if (inSafeZone(map, player)) return { room, events: [] }

  const recent = player.recentFires.filter((at) => at > now - FIRE_WINDOW_MS)
  if (recent.length >= shotsPerSecond(player.gear)) return { room, events: [] }

  const players = new Map(room.players)
  players.set(id, { ...player, lastFireAt: now, recentFires: [...recent, now] })
  const fired: RoomState = { ...room, players }

  const targets: (Vec3 & { id: string })[] = []
  for (const drone of room.drones.values()) {
    if (isLive(drone)) targets.push({ id: drone.id, x: drone.x, y: drone.y, z: drone.z })
  }
  const eye = { x: player.x, y: EYE_HEIGHT, z: player.z }
  const aim = aimVector(intent)
  let found: { target: Vec3 & { id: string }; distance: number } | null = null
  for (let attempt = 0; attempt < AIM_CANDIDATES; attempt++) {
    const candidate = rayConeNearest(eye, aim, AIM_CONE, HITSCAN_RANGE, targets)
    if (!candidate) break
    if (!blockedByBuilding(eye, candidate.target, map)) {
      found = candidate
      break
    }
    targets.splice(targets.indexOf(candidate.target), 1)
  }
  if (!found) return { room: fired, events: [] }

  const drone = fired.drones.get(found.target.id)
  if (!drone) return { room: fired, events: [] }
  return damageDrone(fired, drone, id, 1, now)
}

function stepPlayers(
  room: RoomState,
  map: WorldMap,
  dt: number,
  now: number,
): { room: RoomState; events: SimEvent[] } {
  const events: SimEvent[] = []
  const boxes = boxesOf(map)
  const limit = map.size / 2 - PLAYER_RADIUS
  const clamp = (value: number) => (value < -limit ? -limit : value > limit ? limit : value)
  const players = new Map(room.players)
  let changed = false

  for (const player of room.players.values()) {
    if (player.downedUntil > 0) {
      if (now < player.downedUntil) continue
      players.set(player.id, {
        ...player,
        x: map.spawn.x,
        z: map.spawn.z,
        vx: 0,
        vz: 0,
        shield: MAX_SHIELD,
        downedUntil: 0,
        nextShieldAt: now + SHIELD_REGEN_MS,
        intent: { ...player.intent, dx: 0, dz: 0 },
      })
      events.push({ kind: 'respawn', player: player.id, x: map.spawn.x, y: 0, z: map.spawn.z })
      changed = true
      continue
    }

    const speed = speedOf(player.gear)
    const wanted = {
      x: clamp(player.x + player.intent.dx * speed * dt),
      z: clamp(player.z + player.intent.dz * speed * dt),
    }
    const moved = slideAgainstBoxes({ x: player.x, z: player.z }, wanted, PLAYER_RADIUS, boxes)

    let shield = player.shield
    let nextShieldAt = player.nextShieldAt
    if (shield < MAX_SHIELD && now >= nextShieldAt) {
      shield += 1
      nextShieldAt = now + SHIELD_REGEN_MS
    }

    players.set(player.id, {
      ...player,
      x: moved.x,
      z: moved.z,
      yaw: player.intent.yaw,
      vx: dt > 0 ? (moved.x - player.x) / dt : 0,
      vz: dt > 0 ? (moved.z - player.z) / dt : 0,
      shield,
      nextShieldAt,
    })
    changed = true
  }

  return { room: changed ? { ...room, players } : room, events }
}

/**
 * Who a drone is after: the player who shot it while its anger lasts, otherwise the nearest
 * player inside the engage range. A held target is dropped early if they go down, step into
 * the board's circle, or get further away than a player could shoot from.
 */
function pickTarget(
  drone: DroneState,
  players: ReadonlyMap<string, PlayerState>,
  now: number,
  map: WorldMap,
): PlayerState | null {
  if (drone.target !== null && now < drone.targetUntil) {
    const held = players.get(drone.target)
    if (
      held &&
      held.downedUntil === 0 &&
      !inSafeZone(map, held) &&
      horizontal(drone, held) <= DRONE_CHASE_RANGE
    ) {
      return held
    }
  }

  let best: PlayerState | null = null
  let bestRange = DRONE_ENGAGE_RANGE
  for (const player of players.values()) {
    if (player.downedUntil > 0) continue
    if (inSafeZone(map, player)) continue
    const range = horizontal(drone, player)
    if (range > bestRange) continue
    best = player
    bestRange = range
  }
  return best
}

/**
 * Where a drone wants to be next: on its loop, or orbiting its target at 12 m. The orbit
 * point is one tick of arc ahead, because aiming a whole second ahead would cut the corner
 * and spiral the drone into the player.
 */
function droneGoal(
  drone: DroneState,
  map: WorldMap,
  target: PlayerState | null,
  dt: number,
): Place | null {
  if (target) {
    const away = { x: drone.x - target.x, z: drone.z - target.z }
    const range = Math.hypot(away.x, away.z)
    const angle = range > 1e-6 ? Math.atan2(away.z, away.x) : drone.yaw
    const turned = angle + (DRONE_SPEED / DRONE_CIRCLE_RADIUS) * dt
    return {
      x: target.x + Math.cos(turned) * DRONE_CIRCLE_RADIUS,
      z: target.z + Math.sin(turned) * DRONE_CIRCLE_RADIUS,
    }
  }
  const loop = map.patrols[drone.loop]
  if (!loop || loop.length === 0) return null
  return loop[drone.waypoint % loop.length] ?? null
}

function stepDrones(
  room: RoomState,
  map: WorldMap,
  dt: number,
  now: number,
): { room: RoomState; events: SimEvent[] } {
  const drones = new Map<string, DroneState>()
  const born: BoltState[] = []
  let boltCount = room.ids.bolt

  for (const drone of room.drones.values()) {
    if (!isLive(drone)) {
      if (now < drone.deadUntil) drones.set(drone.id, drone)
      continue
    }

    const target = pickTarget(drone, room.players, now, map)
    const goal = droneGoal(drone, map, target, dt)
    let x = drone.x
    let z = drone.z
    let yaw = drone.yaw
    let waypoint = drone.waypoint
    if (goal) {
      const gap = horizontal(drone, goal)
      let stalled = false
      if (gap > 1e-6) {
        const travel = Math.min(DRONE_SPEED * dt, gap)
        const wanted = {
          x: drone.x + ((goal.x - drone.x) / gap) * travel,
          z: drone.z + ((goal.z - drone.z) / gap) * travel,
        }
        yaw = Math.atan2(goal.x - drone.x, goal.z - drone.z)

        if (target) {
          // An orbit around a player standing next to a tower would fly through it. A blocked
          // drone holds its spot and only turns, which reads as hovering rather than a jump.
          if (!droneBlocked(map, wanted.x, wanted.z)) {
            x = wanted.x
            z = wanted.z
          }
        } else {
          // Off its loop a drone has to cross the block to get home, and a straight line goes
          // through towers. Sliding lets it follow the wall instead of stopping dead.
          const moved = slideAgainstBoxes(drone, wanted, DRONE_CLEARANCE, towersOf(map))
          x = moved.x
          z = moved.z
          stalled = horizontal(drone, moved) < travel * 0.01
        }
      }
      const loop = map.patrols[drone.loop]
      if (!target && loop && loop.length > 0 && (gap <= DRONE_WAYPOINT_REACHED || stalled)) {
        // A drone wedged in a corner would sit there forever, so a blocked one gives up on
        // this waypoint and heads for the next corner of its loop.
        waypoint = (drone.waypoint + 1) % loop.length
      }
    }

    let nextFireAt = drone.nextFireAt
    if (target) {
      yaw = Math.atan2(target.x - x, target.z - z)
      if (now >= drone.nextFireAt) {
        // Aim where the player will be, not where they are. The flight time is measured to
        // where they stand now, which is close enough at these ranges and leaves a player
        // who changes direction after the shot with a clean dodge.
        const flight = Math.hypot(target.x - x, TORSO_HEIGHT - PATROL_Y, target.z - z) / BOLT_SPEED
        const aim = {
          x: target.x + target.vx * flight,
          y: TORSO_HEIGHT,
          z: target.z + target.vz * flight,
        }
        const range = Math.hypot(aim.x - x, aim.y - PATROL_Y, aim.z - z)
        if (range > 1e-6) {
          boltCount += 1
          born.push({
            id: `b${boltCount}`,
            x,
            y: PATROL_Y,
            z,
            vx: ((aim.x - x) / range) * BOLT_SPEED,
            vy: ((aim.y - PATROL_Y) / range) * BOLT_SPEED,
            vz: ((aim.z - z) / range) * BOLT_SPEED,
            ownerDrone: drone.id,
            bornAt: now,
          })
        }
        nextFireAt = now + DRONE_FIRE_MS
      }
    }

    drones.set(drone.id, {
      ...drone,
      x,
      z,
      yaw,
      waypoint,
      nextFireAt,
      target: target ? target.id : null,
      state: target ? 'engage' : 'patrol',
    })
  }

  if (born.length === 0) return { room: { ...room, drones }, events: [] }
  return {
    room: {
      ...room,
      drones,
      bolts: [...room.bolts, ...born],
      ids: { ...room.ids, bolt: boltCount },
    },
    events: [],
  }
}

function boltHits(from: Vec3, to: Vec3, player: PlayerState): Vec3 | null {
  const reach = PLAYER_RADIUS + BOLT_RADIUS
  const travel = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  // Walk the bolt's path in steps no longer than the bodies are wide, so a fast bolt cannot
  // pass through somebody between one tick and the next.
  const samples = Math.max(1, Math.ceil(travel / reach))
  const base = { x: player.x, y: PLAYER_RADIUS, z: player.z }
  const height = PLAYER_HEIGHT - 2 * PLAYER_RADIUS
  for (let n = 0; n <= samples; n++) {
    const t = n / samples
    const at = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    }
    if (capsuleHitBySphere(base, height, PLAYER_RADIUS, at, BOLT_RADIUS)) return at
  }
  return null
}

function stepBolts(
  room: RoomState,
  map: WorldMap,
  dt: number,
  now: number,
): { room: RoomState; events: SimEvent[] } {
  if (room.bolts.length === 0) return { room, events: [] }

  const events: SimEvent[] = []
  const players = new Map(room.players)
  const kept: BoltState[] = []

  for (const bolt of room.bolts) {
    if (now - bolt.bornAt >= BOLT_LIFE_MS) continue

    const from = { x: bolt.x, y: bolt.y, z: bolt.z }
    const to = { x: bolt.x + bolt.vx * dt, y: bolt.y + bolt.vy * dt, z: bolt.z + bolt.vz * dt }

    // A bolt dies the moment it crosses into the board's circle. A tick moves it under a
    // metre, so nothing can jump the ten metre edge and reach somebody standing inside.
    if (inSafeZone(map, from) || inSafeZone(map, to)) continue

    let struck = false
    for (const player of players.values()) {
      if (player.downedUntil > 0) continue
      const at = boltHits(from, to, player)
      if (!at) continue
      // A player standing behind a wall is safe, but one standing in front of it is not, so
      // only the path up to the impact counts.
      if (blockedByBuilding(from, at, map)) continue

      const shield = player.shield > 0 ? player.shield - 1 : 0
      const downed = shield === 0
      players.set(player.id, {
        ...player,
        shield,
        nextShieldAt: now + SHIELD_REGEN_MS,
        downedUntil: downed ? now + DOWNED_MS : player.downedUntil,
        vx: 0,
        vz: 0,
      })
      events.push({
        kind: 'droneHit',
        player: player.id,
        drone: bolt.ownerDrone,
        damage: 1,
        x: at.x,
        y: at.y,
        z: at.z,
      })
      if (downed) {
        events.push({ kind: 'downed', player: player.id, x: player.x, y: 0, z: player.z })
      }
      struck = true
      break
    }
    if (struck) continue

    if (to.y < 0) continue
    if (blockedByBuilding(from, to, map)) continue
    kept.push({ ...bolt, x: to.x, y: to.y, z: to.z })
  }

  return { room: { ...room, players, bolts: kept }, events }
}

function spawnDrones(
  room: RoomState,
  map: WorldMap,
  now: number,
): { room: RoomState; events: SimEvent[] } {
  let live = 0
  for (const drone of room.drones.values()) if (isLive(drone)) live += 1
  if (live >= MAX_DRONES || now < room.nextDroneSpawnAt) return { room, events: [] }

  const spawned = spawnDrone(room, map, now)
  if (!spawned.drone) return { room, events: [] }
  const { id, x, y, z } = spawned.drone
  return {
    room: { ...spawned.room, nextDroneSpawnAt: now + DRONE_SPAWN_MS },
    events: [{ kind: 'spawn', drone: id, x, y, z }],
  }
}

/**
 * One tick of the world: players move and come back, drones hunt and shoot, bolts fly and
 * land, and a lost drone is replaced. The room handed in is never touched.
 */
export function step(
  room: RoomState,
  map: WorldMap,
  dtSeconds: number,
  now: number,
): { room: RoomState; events: SimEvent[] } {
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_STEP_SECONDS)
  const events: SimEvent[] = []
  let next: RoomState = { ...room, tick: room.tick + 1 }

  const walked = stepPlayers(next, map, dt, now)
  next = walked.room
  events.push(...walked.events)

  const flown = stepDrones(next, map, dt, now)
  next = flown.room
  events.push(...flown.events)

  const shot = stepBolts(next, map, dt, now)
  next = shot.room
  events.push(...shot.events)

  const spawned = spawnDrones(next, map, now)
  next = spawned.room
  events.push(...spawned.events)

  return { room: next, events }
}
