// Covers the no-fire circle around the quest board from both sides: a shot out of it, a
// shot into it, and a drone that is pulled towards it by a player standing on the edge. It
// does NOT cover the rest of the rules of play (sim.test.ts does), and it does NOT cover
// the drone bolts that die at the edge, which sim.test.ts already proves.

import { describe, expect, it } from 'vitest'
import { generateMap, OFFICE_SAFE_RADIUS } from '../src/world/map.js'
import { addPlayer, applyFire, createRoom, step } from '../src/world/sim.js'
import type { DroneState, RoomState, WorldMap } from '../src/world/types.js'

/** No buildings, so nothing but the circle can be in the way of a shot or a drone. */
const map: WorldMap = { ...generateMap('vettai-test'), buildings: [] }
const START = 1_700_000_000_000
const DT = 0.05
const GEAR = { blaster: 'mk1' as const, skin: 'default' }

/** A spot `metres` south of the quest board. */
function board(metres: number): { x: number; z: number } {
  return { x: map.office.x, z: map.office.z - metres }
}

function quietRoom(): RoomState {
  return {
    ...createRoom(map, 'safe-zone', 0),
    drones: new Map(),
    nextDroneSpawnAt: Number.MAX_SAFE_INTEGER,
  }
}

function droneAt(at: { x: number; z: number }, id = 'd1'): DroneState {
  return {
    id,
    x: at.x,
    y: 6,
    z: at.z,
    yaw: 0,
    hp: 3,
    state: 'patrol',
    loop: 0,
    waypoint: 0,
    target: null,
    targetUntil: 0,
    nextFireAt: START + 60_000,
    deadUntil: 0,
    damage: new Map(),
  }
}

function withDrone(room: RoomState, drone: DroneState): RoomState {
  return { ...room, drones: new Map([[drone.id, drone]]) }
}

/** The aim from a player's eye to a drone `distance` metres straight ahead at that height. */
function aimAt(distance: number, height: number): { yaw: number; pitch: number } {
  return { yaw: 0, pitch: Math.atan2(height - 1.6, distance) }
}

function distanceToBoard(at: { x: number; z: number }): number {
  return Math.hypot(at.x - map.office.x, at.z - map.office.z)
}

describe('shooting across the edge of the circle', () => {
  it('refuses a shot at a drone inside it, and takes the same shot at one outside', () => {
    const room = addPlayer(quietRoom(), 'p1', GEAR, board(11.5))

    const inside = applyFire(withDrone(room, droneAt(map.office)), 'p1', aimAt(11.5, 6), START, map)
    expect(inside.events).toHaveLength(0)
    expect(inside.room.drones.get('d1')?.hp).toBe(3)
    expect(inside.room.drones.get('d1')?.target).toBeNull()

    // The same player, the same aim, a drone half a metre the other side of the edge.
    const outside = droneAt(board(OFFICE_SAFE_RADIUS + 0.5))
    const taken = applyFire(withDrone(room, outside), 'p1', aimAt(1, 6), START, map)
    expect(taken.events.map((event) => event.kind)).toEqual(['hit'])
    expect(taken.room.drones.get('d1')?.hp).toBe(2)
  })

  it('refuses a shot fired from inside it at a drone out in the open', () => {
    const room = addPlayer(quietRoom(), 'p1', GEAR, board(3))

    const shot = applyFire(withDrone(room, droneAt(board(20))), 'p1', aimAt(17, 6), START, map)

    expect(shot.events).toHaveLength(0)
    expect(shot.room.drones.get('d1')?.hp).toBe(3)
    // A refused shot does not even count against the fire rate: nothing happened.
    expect(shot.room.players.get('p1')?.recentFires).toHaveLength(0)
  })
})

describe('a drone chasing a player who stands on the edge', () => {
  it('never crosses the board, however long the bait stands there', () => {
    const bait = { x: map.office.x - 12, z: map.office.z }
    let room = addPlayer(quietRoom(), 'p1', GEAR, bait)
    room = withDrone(room, droneAt({ x: map.office.x - 24, z: map.office.z }))

    let closest = Number.POSITIVE_INFINITY
    let now = START
    for (let tick = 0; tick < 60 / DT; tick += 1) {
      now += DT * 1000
      room = step(room, map, DT, now).room

      const drone = room.drones.get('d1')
      if (!drone) throw new Error('the drone is gone')
      closest = Math.min(closest, distanceToBoard(drone))

      // The bait is kept standing, so the drone never loses its target to a downed player
      // and the test measures the orbit rather than a respawn.
      const player = room.players.get('p1')
      if (!player) throw new Error('the bait is gone')
      const players = new Map(room.players)
      players.set('p1', { ...player, x: bait.x, z: bait.z, shield: 3, downedUntil: 0 })
      room = { ...room, players }
    }

    expect(room.drones.get('d1')?.state).toBe('engage')
    expect(closest).toBeGreaterThan(OFFICE_SAFE_RADIUS + 1)
  })
})
