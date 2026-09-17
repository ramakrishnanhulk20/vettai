// Covers the rules of play one at a time: walking, shooting, drones, bolts, shields and
// respawns. It does NOT cover the socket, the quest engine or any database work, and it
// does NOT prove the rules hold for every input; sim.property.test.ts does that.

import { describe, expect, it } from 'vitest'
import { generateMap } from '../src/world/map.js'
import {
  addPlayer,
  applyFire,
  applyMove,
  createRoom,
  removePlayer,
  respawnPoint,
  step,
  DRONE_ENGAGE_RANGE,
  INITIAL_DRONES,
  MAX_DRONES,
  MAX_STEP_SECONDS,
} from '../src/world/sim.js'
import type {
  Building,
  BoltState,
  DroneState,
  PlayerState,
  RoomState,
  SimEvent,
  WorldMap,
} from '../src/world/types.js'

const map = generateMap('vettai-test')
const START = 1_700_000_000_000
const DT = 0.05
const OPEN_GROUND = { x: map.spawn.x, z: map.spawn.z + 30 }

/**
 * A room with no drones and none on the way, so a test about walking is only about walking.
 * Without the spawn clock held off, the first tick puts a fresh drone in the sky.
 */
function quietRoom(): RoomState {
  return { ...createRoom(map, 'room-1'), drones: new Map(), nextDroneSpawnAt: Number.MAX_SAFE_INTEGER }
}

/** A room with the sky already full, which is what most of these tests used to assume. */
function busyRoom(): RoomState {
  return createRoom(map, 'room-1', MAX_DRONES)
}

function mustPlayer(room: RoomState, id: string): PlayerState {
  const player = room.players.get(id)
  if (!player) throw new Error(`no player ${id}`)
  return player
}

function mustDrone(room: RoomState, id: string): DroneState {
  const drone = room.drones.get(id)
  if (!drone) throw new Error(`no drone ${id}`)
  return drone
}

function run(
  room: RoomState,
  seconds: number,
  from: number,
  world: WorldMap = map,
): { room: RoomState; events: SimEvent[]; now: number } {
  const ticks = Math.round(seconds / DT)
  let current = room
  let now = from
  const events: SimEvent[] = []
  for (let tick = 0; tick < ticks; tick++) {
    now += DT * 1000
    const result = step(current, world, DT, now)
    current = result.room
    events.push(...result.events)
  }
  return { room: current, events, now }
}

/** A bolt three metres west of a player, flying east at chest height at the drone's speed. */
function boltAt(player: PlayerState, id: string, now: number): BoltState {
  return {
    id,
    x: player.x - 3,
    y: 1,
    z: player.z,
    vx: 18,
    vy: 0,
    vz: 0,
    ownerDrone: 'd1',
    bornAt: now,
  }
}

/** Drones sit down the same street as the player, so only the rules are in the way. */
function droneNear(player: PlayerState, distance: number): DroneState {
  return {
    id: 'd1',
    x: player.x,
    y: 6,
    z: player.z - distance,
    yaw: 0,
    hp: 3,
    state: 'patrol',
    loop: 0,
    waypoint: 0,
    target: null,
    targetUntil: 0,
    nextFireAt: START,
    deadUntil: 0,
    damage: new Map(),
  }
}

/** The same city with a chosen set of buildings, so a test can place a wall exactly. */
function mapWith(buildings: Building[]): WorldMap {
  return { ...map, buildings }
}

function tower(aabb: Building['aabb'], height: number): Building {
  return { lot: [0, 0], type: 0, height, aabb }
}

function withDrone(room: RoomState, drone: DroneState): RoomState {
  return { ...room, drones: new Map([[drone.id, drone]]) }
}

/** The aim from a player's eye to a drone standing `distance` metres straight ahead. */
function aimAt(distance: number, height: number): { yaw: number; pitch: number } {
  return { yaw: 0, pitch: Math.atan2(height - 1.6, distance) }
}

describe('walking', () => {
  it('stops flush against a wall instead of walking through it', () => {
    const building = map.buildings[0]
    if (!building) throw new Error('the map has no buildings')
    const start = {
      x: building.aabb.minX - 3,
      z: (building.aabb.minZ + building.aabb.maxZ) / 2,
    }

    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, start)
    room = applyMove(room, 'p1', { dx: 1, dz: 0, yaw: 0 }, START)
    const after = run(room, 2, START).room

    const player = mustPlayer(after, 'p1')
    expect(player.x).toBeCloseTo(building.aabb.minX - 0.5, 3)
    expect(player.x).toBeLessThan(building.aabb.minX - 0.5)
    expect(player.z).toBeCloseTo(start.z, 6)
  })

  it('walks 6 m in a second, and 7 m with the sprint gear', () => {
    let room = addPlayer(quietRoom(), 'walk', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = addPlayer(room, 'sprint', { blaster: 'mk1', skin: 'default', sprint: true }, OPEN_GROUND)
    room = applyMove(room, 'walk', { dx: 0, dz: 1, yaw: 0 }, START)
    room = applyMove(room, 'sprint', { dx: 0, dz: 1, yaw: 0 }, START)

    const after = run(room, 1, START).room
    expect(mustPlayer(after, 'walk').z - OPEN_GROUND.z).toBeCloseTo(6, 6)
    expect(mustPlayer(after, 'sprint').z - OPEN_GROUND.z).toBeCloseTo(7, 6)
  })

  it('normalises a move intent so a long vector buys no speed', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = applyMove(room, 'p1', { dx: 0, dz: 50, yaw: 1.2 }, START)

    const intent = mustPlayer(room, 'p1').intent
    expect(Math.hypot(intent.dx, intent.dz)).toBeCloseTo(1, 9)
    expect(mustPlayer(run(room, 1, START).room, 'p1').z - OPEN_GROUND.z).toBeCloseTo(6, 6)
  })

  it('leaves the room it was handed untouched', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = applyMove(room, 'p1', { dx: 0, dz: 1, yaw: 0 }, START)
    const before = JSON.stringify([...room.players.values()])

    step(room, map, DT, START + 50)
    expect(JSON.stringify([...room.players.values()])).toBe(before)
    expect(room.tick).toBe(0)
  })
})

describe('taking fire', () => {
  it('costs one shield bar when a bolt lands on a standing player', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const withBolt = { ...room, bolts: [boltAt(mustPlayer(room, 'p1'), 'b1', START)] }

    const after = run(withBolt, 0.5, START)
    const hits = after.events.filter((event) => event.kind === 'droneHit')
    expect(hits).toHaveLength(1)
    expect(mustPlayer(after.room, 'p1').shield).toBe(2)
    expect(after.room.bolts).toHaveLength(0)
  })

  it('misses a player who is moving out of the way', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = applyMove(room, 'p1', { dx: 0, dz: 1, yaw: 0 }, START)
    const bolt = boltAt(mustPlayer(room, 'p1'), 'b1', START)
    const withBolt = { ...room, bolts: [{ ...bolt, x: bolt.x - 3 }] }

    const after = run(withBolt, 1, START)
    expect(after.events.filter((event) => event.kind === 'droneHit')).toHaveLength(0)
    expect(mustPlayer(after.room, 'p1').shield).toBe(3)
  })

  it('goes down at zero shield and comes back on a nearby crossing three seconds later', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    let now = START
    const events: SimEvent[] = []
    for (const id of ['b1', 'b2', 'b3']) {
      const shot = { ...room, bolts: [boltAt(mustPlayer(room, 'p1'), id, now)] }
      const result = run(shot, 0.5, now)
      room = result.room
      now = result.now
      events.push(...result.events)
    }

    const downed = events.filter((event) => event.kind === 'downed')
    expect(downed).toHaveLength(1)
    expect(mustPlayer(room, 'p1').shield).toBe(0)
    expect(mustPlayer(room, 'p1').downedUntil).toBeGreaterThan(now)

    const back = run(room, 3.1, now)
    const respawns = back.events.filter((event) => event.kind === 'respawn')
    expect(respawns).toHaveLength(1)
    const player = mustPlayer(back.room, 'p1')
    const crossing = respawnPoint(map, OPEN_GROUND)
    expect(player.x).toBe(crossing.x)
    expect(player.z).toBe(crossing.z)
    expect(player.shield).toBe(3)
    expect(player.downedUntil).toBe(0)
  })

  it('hands back one shield bar after eight quiet seconds', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const hit = run({ ...room, bolts: [boltAt(mustPlayer(room, 'p1'), 'b1', START)] }, 0.5, START)
    expect(mustPlayer(hit.room, 'p1').shield).toBe(2)

    const nearly = run(hit.room, 7.5, hit.now)
    expect(mustPlayer(nearly.room, 'p1').shield).toBe(2)

    const regrown = run(nearly.room, 1, nearly.now)
    expect(mustPlayer(regrown.room, 'p1').shield).toBe(3)
  })
})

describe('drones', () => {
  it('engages a player at 20 m and fires every two seconds', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const ready = withDrone(room, droneNear(mustPlayer(room, 'p1'), 20))

    // Two seconds of looking, then a bolt, then one more two seconds after that.
    const after = run(ready, 5, START)
    expect(mustDrone(after.room, 'd1').state).toBe('engage')
    expect(after.room.ids.bolt).toBe(2)
  })

  it('ignores a player who is further than the engage range away', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const ready = withDrone(room, droneNear(mustPlayer(room, 'p1'), DRONE_ENGAGE_RANGE + 1))

    const after = run(ready, 3, START)
    expect(mustDrone(after.room, 'd1').state).toBe('patrol')
    expect(after.room.ids.bolt).toBe(0)
  })

  it('closes to a twelve metre circle around its target', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const ready = withDrone(room, droneNear(mustPlayer(room, 'p1'), 16))

    const after = run(ready, 8, START)
    const drone = mustDrone(after.room, 'd1')
    const player = mustPlayer(after.room, 'p1')
    expect(Math.hypot(drone.x - player.x, drone.z - player.z)).toBeCloseTo(12, 1)
  })

  it('keeps twelve alive and replaces a lost one no more than once every fifteen seconds', () => {
    const full = busyRoom()
    expect(full.drones.size).toBe(12)

    const short = new Map(full.drones)
    const firstId = [...short.keys()][0]
    if (!firstId) throw new Error('the room has no drones')
    short.delete(firstId)

    const replaced = step({ ...full, drones: short }, map, DT, START)
    expect(replaced.events.filter((event) => event.kind === 'spawn')).toHaveLength(1)
    expect(replaced.room.drones.size).toBe(12)

    const shortAgain = new Map(replaced.room.drones)
    const nextId = [...shortAgain.keys()][0]
    if (!nextId) throw new Error('the room has no drones')
    shortAgain.delete(nextId)

    const tooSoon = step({ ...replaced.room, drones: shortAgain }, map, DT, START + 1000)
    expect(tooSoon.events.filter((event) => event.kind === 'spawn')).toHaveLength(0)
    expect(tooSoon.room.drones.size).toBe(11)

    const late = step({ ...replaced.room, drones: shortAgain }, map, DT, START + 15_000)
    expect(late.events.filter((event) => event.kind === 'spawn')).toHaveLength(1)
  })

  it('starts at least two drones inside 60 m of the spawn', () => {
    const near = [...createRoom(map, 'room-1').drones.values()].filter(
      (drone) => Math.hypot(drone.x - map.spawn.x, drone.z - map.spawn.z) < 60,
    )
    expect(near.length).toBeGreaterThanOrEqual(2)
  })

  it('is born with six and fills up on the spawn clock, so rejoining buys no batch', () => {
    const fresh = createRoom(map, 'room-1')
    expect(fresh.drones.size).toBe(INITIAL_DRONES)

    let room = fresh
    let now = START
    // One spawn every fifteen seconds, and the room needs six more to be full.
    for (let cycle = 0; cycle < MAX_DRONES - INITIAL_DRONES; cycle += 1) {
      now += 15_000
      room = step(room, map, DT, now).room
      expect(room.drones.size).toBe(INITIAL_DRONES + cycle + 1)
    }

    expect(room.drones.size).toBe(MAX_DRONES)

    now += 15_000
    expect(step(room, map, DT, now).room.drones.size).toBe(MAX_DRONES)
  })

  it('turns on a player who shoots it from 40 m and fires back inside two seconds', () => {
    const open = mapWith([])
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const ahead = { ...droneNear(mustPlayer(room, 'p1'), 0), x: OPEN_GROUND.x, z: OPEN_GROUND.z + 40 }
    const far = withDrone(room, ahead)

    const shot = applyFire(far, 'p1', aimAt(40, 6), START, open)
    expect(mustDrone(shot.room, 'd1').target).toBe('p1')
    expect(mustDrone(shot.room, 'd1').state).toBe('engage')

    const after = run(shot.room, 2, START, open)
    expect(mustDrone(after.room, 'd1').state).toBe('engage')
    expect(after.room.ids.bolt).toBeGreaterThanOrEqual(1)
  })

  it('leads a walking player, and misses the one who changes direction', () => {
    const open = mapWith([])
    const start = { x: 0, z: 40 }
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, start)
    room = withDrone(room, { ...droneNear(mustPlayer(room, 'p1'), 0), x: start.x, z: start.z + 12 })
    room = applyMove(room, 'p1', { dx: 1, dz: 0, yaw: 0 }, START)

    const walking = run(room, 5, START, open)
    expect(walking.events.filter((event) => event.kind === 'droneHit').length).toBeGreaterThan(0)

    const fired = run(room, 2.15, START, open)
    expect(fired.room.bolts.length).toBe(1)
    const dodging = applyMove(fired.room, 'p1', { dx: -1, dz: 0, yaw: 0 }, fired.now)
    const after = run(dodging, 1.5, fired.now, open)
    expect(after.events.filter((event) => event.kind === 'droneHit')).toHaveLength(0)
  })
})

describe('shooting', () => {
  it('lands a hit on the drone the player is aiming at', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const drone = droneNear(mustPlayer(room, 'p1'), 0)
    const ahead = { ...drone, x: OPEN_GROUND.x, z: OPEN_GROUND.z + 10 }
    const shot = applyFire(withDrone(room, ahead), 'p1', aimAt(10, 6), START, map)

    expect(shot.events.map((event) => event.kind)).toEqual(['hit'])
    expect(mustDrone(shot.room, 'd1').hp).toBe(2)
  })

  it('misses when the aim is outside the assist cone', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const drone = droneNear(mustPlayer(room, 'p1'), 0)
    const ahead = { ...drone, x: OPEN_GROUND.x, z: OPEN_GROUND.z + 10 }
    const shot = applyFire(withDrone(room, ahead), 'p1', { yaw: 1, pitch: 0 }, START, map)

    expect(shot.events).toHaveLength(0)
    expect(mustDrone(shot.room, 'd1').hp).toBe(3)
  })

  it('reaches a drone nine degrees off the aim and gives up at fourteen', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    // At eye height and with no buildings anywhere, the angle off the aim is exactly the yaw,
    // so this measures the assist cone and nothing else.
    const level = {
      ...droneNear(mustPlayer(room, 'p1'), 0),
      x: OPEN_GROUND.x,
      y: 1.6,
      z: OPEN_GROUND.z + 10,
    }
    const open = mapWith([])
    const offBy = (degrees: number) => ({ yaw: (degrees * Math.PI) / 180, pitch: 0 })

    const near = applyFire(withDrone(room, level), 'p1', offBy(9), START, open)
    expect(near.events.map((event) => event.kind)).toEqual(['hit'])
    expect(mustDrone(near.room, 'd1').hp).toBe(2)

    const wide = applyFire(withDrone(room, level), 'p1', offBy(14), START, open)
    expect(wide.events).toHaveLength(0)
    expect(mustDrone(wide.room, 'd1').hp).toBe(3)
  })

  it('gives the kill to the player who did the most damage', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = addPlayer(room, 'p2', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const drone = droneNear(mustPlayer(room, 'p1'), 0)
    room = withDrone(room, { ...drone, x: OPEN_GROUND.x, z: OPEN_GROUND.z + 10 })

    const aim = aimAt(10, 6)
    room = applyFire(room, 'p1', aim, START, map).room
    room = applyFire(room, 'p1', aim, START + 300, map).room
    const last = applyFire(room, 'p2', aim, START + 600, map)

    const kill = last.events.find((event) => event.kind === 'kill')
    expect(kill?.player).toBe('p1')
    expect(mustDrone(last.room, 'd1').state).toBe('dead')
  })

  it('tells the player who fired the last shot that the kill went to somebody else', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = addPlayer(room, 'p2', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const drone = droneNear(mustPlayer(room, 'p1'), 0)
    room = withDrone(room, { ...drone, x: OPEN_GROUND.x, z: OPEN_GROUND.z + 10 })

    const aim = aimAt(10, 6)
    room = applyFire(room, 'p1', aim, START, map).room
    room = applyFire(room, 'p1', aim, START + 300, map).room
    const last = applyFire(room, 'p2', aim, START + 600, map)

    expect(last.events.find((event) => event.kind === 'assist')).toMatchObject({
      player: 'p2',
      drone: 'd1',
    })

    // The player who earned the kill is told about the kill, and nothing else.
    const own = applyFire(room, 'p1', aim, START + 900, map)
    expect(own.events.find((event) => event.kind === 'kill')?.player).toBe('p1')
    expect(own.events.some((event) => event.kind === 'assist')).toBe(false)
  })

  it('holds the mk1 to four shots a second and the mk2 to six', () => {
    let room = addPlayer(quietRoom(), 'mk1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = addPlayer(room, 'mk2', { blaster: 'mk2', skin: 'default' }, OPEN_GROUND)

    for (let shot = 0; shot < 8; shot++) {
      const at = START + shot * 100
      room = applyFire(room, 'mk1', { yaw: 0, pitch: 0 }, at, map).room
      room = applyFire(room, 'mk2', { yaw: 0, pitch: 0 }, at, map).room
    }

    expect(mustPlayer(room, 'mk1').recentFires).toHaveLength(4)
    expect(mustPlayer(room, 'mk2').recentFires).toHaveLength(6)
  })

  it('refuses to fire while the player is down', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const players = new Map(room.players)
    players.set('p1', { ...mustPlayer(room, 'p1'), shield: 0, downedUntil: START + 3000 })
    const drone = droneNear(mustPlayer(room, 'p1'), 0)
    const down = withDrone({ ...room, players }, { ...drone, x: OPEN_GROUND.x, z: OPEN_GROUND.z + 10 })

    const shot = applyFire(down, 'p1', aimAt(10, 6), START, map)
    expect(shot.events).toHaveLength(0)
    expect(mustDrone(shot.room, 'd1').hp).toBe(3)
  })

  it('forgets the damage of a player who left, so no kill is credited to a ghost', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = addPlayer(room, 'p2', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    const drone = droneNear(mustPlayer(room, 'p1'), 0)
    room = withDrone(room, { ...drone, x: OPEN_GROUND.x, z: OPEN_GROUND.z + 10 })

    const aim = aimAt(10, 6)
    room = applyFire(room, 'p1', aim, START, map).room
    room = applyFire(room, 'p1', aim, START + 300, map).room
    room = removePlayer(room, 'p1')
    const last = applyFire(room, 'p2', aim, START + 600, map)

    const kill = last.events.find((event) => event.kind === 'kill')
    expect(kill?.player).toBe('p2')
    expect(last.room.players.has('p1')).toBe(false)
  })
})

describe('the quest board is a safe zone', () => {
  const open = mapWith([])
  const board = (metres: number) => ({ x: map.office.x, z: map.office.z - metres })

  it('never lets a drone shoot a player standing at the board', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, board(3))
    room = withDrone(room, droneNear(mustPlayer(room, 'p1'), 0))

    const after = run(room, 10, START, open)
    expect(after.events.filter((event) => event.kind === 'droneHit')).toHaveLength(0)
    expect(mustPlayer(after.room, 'p1').shield).toBe(3)
    expect(mustDrone(after.room, 'd1').state).toBe('patrol')
    expect(mustDrone(after.room, 'd1').target).toBeNull()
  })

  it('shoots the same player fifteen metres down the street', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, board(15))
    room = withDrone(room, droneNear(mustPlayer(room, 'p1'), 0))

    const after = run(room, 10, START, open)
    expect(after.events.filter((event) => event.kind === 'droneHit').length).toBeGreaterThan(0)
  })

  it('refuses a shot fired from inside it, so nobody farms from where nothing can answer', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, board(3))
    const ahead = { ...droneNear(mustPlayer(room, 'p1'), 0), x: map.office.x, z: map.office.z + 17 }
    room = withDrone(room, ahead)

    const shot = applyFire(room, 'p1', aimAt(20, 6), START, open)
    expect(shot.events).toHaveLength(0)
    expect(mustDrone(shot.room, 'd1').hp).toBe(3)
    expect(mustDrone(shot.room, 'd1').target).toBeNull()
    // The refused shot does not even count against the fire rate: nothing happened.
    expect(mustPlayer(shot.room, 'p1').recentFires).toHaveLength(0)
  })

  it('lets the same player shoot the same drone one step outside the circle', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, board(11))
    const ahead = { ...droneNear(mustPlayer(room, 'p1'), 0), x: map.office.x, z: map.office.z + 17 }
    room = withDrone(room, ahead)

    const shot = applyFire(room, 'p1', aimAt(28, 6), START, open)
    expect(shot.events.map((event) => event.kind)).toEqual(['hit'])
    expect(mustDrone(shot.room, 'd1').hp).toBe(2)
    expect(mustDrone(shot.room, 'd1').target).toBe('p1')
  })
})

describe('the step clamp', () => {
  it('never lets a long tick carry a sprinting player through a wall', () => {
    const building = map.buildings[0]
    if (!building) throw new Error('the map has no buildings')
    const start = {
      x: building.aabb.minX - 0.6,
      z: (building.aabb.minZ + building.aabb.maxZ) / 2,
    }

    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default', sprint: true }, start)
    room = applyMove(room, 'p1', { dx: 1, dz: 0, yaw: 0 }, START)

    // Five seconds in one step: a paused process, a laptop lid, a stalled event loop.
    const after = step(room, map, 5, START + 5000).room

    const player = mustPlayer(after, 'p1')
    expect(player.x).toBeLessThanOrEqual(building.aabb.minX - 0.5)
    expect(player.x - start.x).toBeLessThanOrEqual(7 * MAX_STEP_SECONDS)
  })

  it('does nothing at all on a negative step', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, OPEN_GROUND)
    room = applyMove(room, 'p1', { dx: 0, dz: 1, yaw: 0 }, START)

    const after = step(room, map, -5, START).room

    const player = mustPlayer(after, 'p1')
    expect(player.x).toBe(OPEN_GROUND.x)
    expect(player.z).toBe(OPEN_GROUND.z)
    expect(player.vx).toBe(0)
    expect(player.vz).toBe(0)
    expect(after.tick).toBe(room.tick + 1)
  })
})

describe('walls', () => {
  const PILLAR = tower({ minX: -0.4, maxX: 0.4, minZ: 4, maxZ: 4.4 }, 30)
  const GROUND = { x: 0, z: 0 }
  /** These tests stand on the origin, so the quest board is moved out of its safe circle. */
  const away = (buildings: Building[]): WorldMap => ({
    ...mapWith(buildings),
    office: { x: 120, z: 120 },
  })
  // Aimed between the two drones below, so both sit inside the twelve degree assist cone.
  const BETWEEN = { yaw: Math.atan2(1.5, 20), pitch: Math.atan2(4.4, Math.hypot(1.5, 20)) }

  it('does not let a player shoot a drone hidden behind a tower', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, GROUND)
    const hidden = { ...droneNear(mustPlayer(room, 'p1'), 0), id: 'd1', x: 0, z: 20 }
    room = withDrone(room, hidden)

    const blocked = applyFire(room, 'p1', BETWEEN, START, away([PILLAR]))
    expect(blocked.events).toHaveLength(0)
    expect(mustDrone(blocked.room, 'd1').hp).toBe(3)

    const clear = applyFire(room, 'p1', BETWEEN, START, away([]))
    expect(clear.events.map((event) => event.kind)).toEqual(['hit'])
    expect(mustDrone(clear.room, 'd1').hp).toBe(2)
  })

  it('takes the next drone in the cone when the nearest one is behind the tower', () => {
    let room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, GROUND)
    const hidden = { ...droneNear(mustPlayer(room, 'p1'), 0), id: 'd1', x: 0, z: 20 }
    const open = { ...droneNear(mustPlayer(room, 'p1'), 0), id: 'd2', x: 3, z: 20 }
    room = { ...room, drones: new Map([[hidden.id, hidden], [open.id, open]]) }

    const shot = applyFire(room, 'p1', BETWEEN, START, away([PILLAR]))
    const hit = shot.events.find((event) => event.kind === 'hit')
    expect(hit?.drone).toBe('d2')
    expect(mustDrone(shot.room, 'd1').hp).toBe(3)
    expect(mustDrone(shot.room, 'd2').hp).toBe(2)
  })

  it('kills a bolt that flies into a building instead of through it', () => {
    const room = addPlayer(quietRoom(), 'p1', { blaster: 'mk1', skin: 'default' }, GROUND)
    const wall = tower({ minX: 2, maxX: 8, minZ: -3, maxZ: 3 }, 20)
    const incoming: BoltState = {
      id: 'b1',
      x: 12,
      y: 1,
      z: 0,
      vx: -12,
      vy: 0,
      vz: 0,
      ownerDrone: 'd1',
      bornAt: START,
    }

    const stopped = run({ ...room, bolts: [incoming] }, 1.5, START, away([wall]))
    expect(stopped.events.filter((event) => event.kind === 'droneHit')).toHaveLength(0)
    expect(stopped.room.bolts).toHaveLength(0)
    expect(mustPlayer(stopped.room, 'p1').shield).toBe(3)

    const through = run({ ...room, bolts: [incoming] }, 1.5, START, away([]))
    expect(through.events.filter((event) => event.kind === 'droneHit')).toHaveLength(1)
    expect(mustPlayer(through.room, 'p1').shield).toBe(2)
  })
})
