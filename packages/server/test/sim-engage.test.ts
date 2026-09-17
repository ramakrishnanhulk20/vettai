// Covers when a drone decides to come down on a player: the two second look before it does,
// the board's circle it never looks into, the range it gives up at, and the height it drops
// to once it is on somebody. It does NOT cover being shot first, which turns a drone on the
// shooter with no look at all (sim.test.ts), and it does NOT cover respawns
// (sim-respawn.test.ts).

import { describe, expect, it } from 'vitest'
import { generateMap } from '../src/world/map.js'
import {
  addPlayer,
  applyMove,
  createRoom,
  step,
  DRONE_ENGAGE_RANGE,
  DRONE_ENGAGE_Y,
  DRONE_SIGHT_MS,
} from '../src/world/sim.js'
import type { DroneState, Place, RoomState, WorldMap } from '../src/world/types.js'

/** No buildings, so nothing but the rules can stand between a drone and a player. */
const map: WorldMap = { ...generateMap('vettai-test'), buildings: [] }
const START = 1_700_000_000_000
const DT = 0.05
const GEAR = { blaster: 'mk1' as const, skin: 'default' }

function quietRoom(): RoomState {
  return {
    ...createRoom(map, 'engage', 0),
    drones: new Map(),
    nextDroneSpawnAt: Number.MAX_SAFE_INTEGER,
  }
}

/**
 * A drone hovering where it is put. Loop 99 is no loop at all, so a patrolling one has
 * nowhere to fly and the distance to the player is whatever the test chose; an engaged one
 * still orbits, because an orbit does not come from the loop.
 */
function parked(at: Place, fires = false): DroneState {
  return {
    id: 'd1',
    x: at.x,
    y: 6,
    z: at.z,
    yaw: 0,
    hp: 3,
    state: 'patrol',
    loop: 99,
    waypoint: 0,
    target: null,
    targetUntil: 0,
    nextFireAt: fires ? START : START + 1_000_000,
    deadUntil: 0,
    damage: new Map(),
  }
}

function withDrone(room: RoomState, drone: DroneState): RoomState {
  return { ...room, drones: new Map([[drone.id, drone]]) }
}

function run(room: RoomState, seconds: number, from: number): { room: RoomState; now: number } {
  let current = room
  let now = from
  for (let tick = 0; tick < Math.round(seconds / DT); tick++) {
    now += DT * 1000
    current = step(current, map, DT, now).room
  }
  return { room: current, now }
}

function mustDrone(room: RoomState, id = 'd1'): DroneState {
  const drone = room.drones.get(id)
  if (!drone) throw new Error(`no drone ${id}`)
  return drone
}

/** A spot `metres` south of the quest board, which is the middle of the safe circle. */
function board(metres: number): Place {
  return { x: map.office.x, z: map.office.z - metres }
}

describe('a drone watching the street', () => {
  it('comes down on a player who stands 20 m from its patrol path, after two seconds', () => {
    const loop = map.patrols[0]
    const waypoint = loop?.[0]
    if (!waypoint) throw new Error('the map has no patrol loops')

    const still = { x: waypoint.x + 20, z: waypoint.z }
    let room = addPlayer(quietRoom(), 'p1', GEAR, still)
    room = withDrone(room, { ...parked(waypoint), loop: 0, waypoint: 1 })

    const looking = run(room, DRONE_SIGHT_MS / 1000 - 0.5, START)
    expect(mustDrone(looking.room).state).toBe('patrol')

    const seen = run(looking.room, 1, looking.now)
    expect(mustDrone(seen.room).state).toBe('engage')
    expect(mustDrone(seen.room).target).toBe('p1')
  })

  it('never notices a player standing at the board, however long they stand there', () => {
    let room = addPlayer(quietRoom(), 'p1', GEAR, board(2))
    room = withDrone(room, parked(board(12), true))

    let current = room
    let now = START
    for (let tick = 0; tick < 60 / DT; tick++) {
      now += DT * 1000
      current = step(current, map, DT, now).room
      if (mustDrone(current).state !== 'patrol') throw new Error(`engaged at tick ${tick}`)
    }

    expect(mustDrone(current).target).toBeNull()
    expect(current.ids.bolt).toBe(0)
    expect(current.players.get('p1')?.shield).toBe(3)
  })

  it('goes back to its patrol once the player has walked past the engage range', () => {
    const open = { x: map.office.x + 60, z: map.office.z }
    let room = addPlayer(quietRoom(), 'p1', GEAR, open)
    room = withDrone(room, parked({ x: open.x + 20, z: open.z }))

    const engaged = run(room, 3, START)
    expect(mustDrone(engaged.room).state).toBe('engage')

    // Away from the drone at 6 m/s against its 3 m/s, so the gap opens by 3 m every second.
    const walking = applyMove(engaged.room, 'p1', { dx: -1, dz: 0, yaw: 0 }, engaged.now)
    const gone = run(walking, 12, engaged.now)

    const drone = mustDrone(gone.room)
    const player = gone.room.players.get('p1')
    if (!player) throw new Error('the player is gone')
    expect(Math.hypot(drone.x - player.x, drone.z - player.z)).toBeGreaterThan(DRONE_ENGAGE_RANGE)
    expect(drone.state).toBe('patrol')
    expect(drone.target).toBeNull()
  })

  it('drops to the height a phone camera can look at while it fights', () => {
    const open = { x: map.office.x + 60, z: map.office.z }
    let room = addPlayer(quietRoom(), 'p1', GEAR, open)
    room = withDrone(room, parked({ x: open.x + 15, z: open.z }))

    const after = run(room, 5, START)

    const drone = mustDrone(after.room)
    expect(drone.state).toBe('engage')
    expect(drone.y).toBeCloseTo(DRONE_ENGAGE_Y, 6)
  })
})
