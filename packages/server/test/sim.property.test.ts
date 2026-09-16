// Covers the rules that must hold for every input, not just the ones a test author thought
// of: walls, speed, fire rate, drone count, dead drones and kill credit. It does NOT cover
// timing or performance, and the speed property runs in a room with no drones, because a
// respawn is a teleport and would look like a player moving faster than the cap.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { generateMap } from '../src/world/map.js'
import { addPlayer, applyFire, applyMove, createRoom, step } from '../src/world/sim.js'
import type { Box, DroneState, Place, PlayerState, RoomState } from '../src/world/types.js'

const map = generateMap('vettai-property')
const START = 1_700_000_000_000
const DT = 0.05
const PLAYER_RADIUS = 0.5
const RUNS = { numRuns: 200 }
const MK1 = { blaster: 'mk1', skin: 'default' } as const
const MK2 = { blaster: 'mk2', skin: 'default' } as const

const starts: Place[] = [map.spawn, map.office, map.shop, ...map.landmarks, ...map.courier]

/** Street crossings only: a drone parked north of one of these starts over the road. */
const crossings: Place[] = [map.spawn, map.office, map.shop, ...map.landmarks]
const DRONE_Y = 6
const DRONE_CLEARANCE = 1

/**
 * One held direction. A real client holds a key for many ticks, and a fresh random direction
 * every tick only ever jitters on the spot, which would never reach a wall to test it.
 */
const moveArb = fc.record({
  dx: fc.double({ min: -1, max: 1, noNaN: true }),
  dz: fc.double({ min: -1, max: 1, noNaN: true }),
  yaw: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  hold: fc.integer({ min: 1, max: 60 }),
})

const MAX_TICKS = 400

function mustPlayer(room: RoomState, id: string): PlayerState {
  const player = room.players.get(id)
  if (!player) throw new Error(`no player ${id}`)
  return player
}

function insideInflated(place: Place, box: Box, radius: number): boolean {
  return (
    place.x > box.minX - radius &&
    place.x < box.maxX + radius &&
    place.z > box.minZ - radius &&
    place.z < box.maxZ + radius
  )
}

function insideAnyBuilding(place: Place): boolean {
  for (const building of map.buildings) {
    if (insideInflated(place, building.aabb, PLAYER_RADIUS)) return true
  }
  return false
}

function liveDrones(room: RoomState): DroneState[] {
  return [...room.drones.values()].filter((drone) => drone.state !== 'dead' && drone.hp > 0)
}

function startAt(index: number): Place {
  return starts[index % starts.length] ?? map.spawn
}

describe('no player ever ends up inside a building', () => {
  it('holds after any sequence of move intents', () => {
    fc.assert(
      fc.property(
        fc.array(moveArb, { maxLength: 60, size: 'max' }),
        fc.nat({ max: starts.length - 1 }),
        (moves, where) => {
          let room = addPlayer(createRoom(map, 'walls'), 'p1', MK1, startAt(where))
          let now = START
          let ticks = 0
          for (const move of moves) {
            room = applyMove(room, 'p1', move, now)
            for (let held = 0; held < move.hold && ticks < MAX_TICKS; held++) {
              now += 50
              ticks += 1
              room = step(room, map, DT, now).room
              if (insideAnyBuilding(mustPlayer(room, 'p1'))) return false
            }
          }
          return true
        },
      ),
      RUNS,
    )
  })
})

describe('nobody outruns the speed cap', () => {
  it('never covers more ground in a second than the gear allows', () => {
    fc.assert(
      fc.property(
        fc.array(moveArb, { minLength: 2, maxLength: 60, size: 'max' }),
        fc.boolean(),
        fc.nat({ max: starts.length - 1 }),
        (moves, sprint, where) => {
          const gear = sprint ? { ...MK1, sprint: true } : MK1
          const cap = (sprint ? 7 : 6) + 0.01
          const quiet: RoomState = { ...createRoom(map, 'speed'), drones: new Map() }
          let room = addPlayer(quiet, 'p1', gear, startAt(where))
          let now = START
          let ticks = 0
          const trail: Place[] = [mustPlayer(room, 'p1')]

          for (const move of moves) {
            room = applyMove(room, 'p1', move, now)
            for (let held = 0; held < move.hold && ticks < MAX_TICKS; held++) {
              now += 50
              ticks += 1
              room = step(room, map, DT, now).room
              const at = mustPlayer(room, 'p1')
              trail.push({ x: at.x, z: at.z })
              const second = trail[trail.length - 21]
              if (!second) continue
              if (Math.hypot(at.x - second.x, at.z - second.z) > cap) return false
            }
          }
          return true
        },
      ),
      RUNS,
    )
  })
})

describe('the blaster holds its fire rate', () => {
  it('never lets more shots through than the cap in any one second', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 400 }), { maxLength: 120, size: 'max' }),
        fc.boolean(),
        (gaps, mk2) => {
          const cap = mk2 ? 6 : 4
          let room = addPlayer(createRoom(map, 'rate'), 'p1', mk2 ? MK2 : MK1, map.spawn)
          let now = START
          const accepted: number[] = []

          for (const gap of gaps) {
            now += gap
            const before = mustPlayer(room, 'p1').lastFireAt
            room = applyFire(room, 'p1', { yaw: 0, pitch: 0 }, now, map).room
            if (mustPlayer(room, 'p1').lastFireAt !== before) accepted.push(now)
          }

          for (const at of accepted) {
            const window = accepted.filter((shot) => shot >= at && shot < at + 1000)
            if (window.length > cap) return false
          }
          return true
        },
      ),
      RUNS,
    )
  })
})

describe('drones', () => {
  it('never has more than six alive, and a dead one never shoots', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ jump: fc.integer({ min: 50, max: 3000 }), kill: fc.boolean() }), {
          maxLength: 300,
          size: 'max',
        }),
        (ticks) => {
          let room = addPlayer(createRoom(map, 'drones'), 'p1', MK1, map.spawn)
          let now = START
          const bornAlive = new Map<string, boolean>()

          for (const beat of ticks) {
            if (beat.kill) {
              const live = liveDrones(room)
              const victim = live[0]
              if (victim) {
                const drones = new Map(room.drones)
                drones.set(victim.id, { ...victim, hp: 0, state: 'dead', deadUntil: now + 2000 })
                room = { ...room, drones }
              }
            }

            const before = new Map(room.drones)
            const flying = new Map(room.bolts.map((bolt) => [bolt.id, bolt.ownerDrone]))
            now += beat.jump
            const result = step(room, map, DT, now)
            room = result.room

            if (liveDrones(room).length > 6) return false

            for (const bolt of room.bolts) {
              if (flying.has(bolt.id)) continue
              const owner = before.get(bolt.ownerDrone)
              const wasLive = owner !== undefined && owner.state !== 'dead' && owner.hp > 0
              bornAlive.set(bolt.id, wasLive)
              if (!wasLive) return false
            }

            const landed = new Set(room.bolts.map((bolt) => bolt.id))
            for (const event of result.events) {
              if (event.kind !== 'droneHit') continue
              // The hit has to trace back to a bolt that vanished this tick and that a live
              // drone fired, so a wreck can never be the source of damage.
              const traced = [...flying.entries()].some(
                ([id, owner]) =>
                  !landed.has(id) && owner === event.drone && bornAlive.get(id) !== false,
              )
              if (!traced) return false
            }
          }
          return true
        },
      ),
      RUNS,
    )
  })
})

describe('kill credit', () => {
  it('always names the player who did the most damage to that drone', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 3, maxLength: 12, size: 'max' }), (shooters) => {
        const ahead: DroneState = {
          id: 'd1',
          x: map.spawn.x,
          y: 6,
          z: map.spawn.z + 10,
          yaw: 0,
          hp: 3,
          state: 'patrol',
          loop: 0,
          waypoint: 0,
          target: null,
          nextFireAt: START + 100000,
          deadUntil: 0,
          damage: new Map(),
        }
        let room = addPlayer(createRoom(map, 'credit'), 'p1', MK1, map.spawn)
        room = addPlayer(room, 'p2', MK1, map.spawn)
        room = { ...room, drones: new Map([[ahead.id, ahead]]) }

        const aim = { yaw: 0, pitch: Math.atan2(6 - 1.6, 10) }
        const damage = new Map<string, number>()
        let now = START

        for (const first of shooters) {
          const id = first ? 'p1' : 'p2'
          now += 300
          const result = applyFire(room, id, aim, now, map)
          room = result.room
          for (const event of result.events) {
            if (event.kind === 'hit') damage.set(id, (damage.get(id) ?? 0) + event.damage)
            if (event.kind !== 'kill') continue
            const top = Math.max(...damage.values())
            if ((damage.get(event.player) ?? 0) !== top) return false
          }
        }
        return true
      }),
      RUNS,
    )
  })
})

describe('the map is the same everywhere', () => {
  it('draws the same city from the same seed and never blocks a fixed place', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), (seed) => {
        const once = generateMap(seed)
        const twice = generateMap(seed)
        if (JSON.stringify(once) !== JSON.stringify(twice)) return false

        const places = [once.office, once.shop, once.spawn, ...once.landmarks, ...once.courier]
        for (const place of places) {
          for (const building of once.buildings) {
            if (insideInflated(place, building.aabb, PLAYER_RADIUS)) return false
          }
        }
        return true
      }),
      RUNS,
    )
  })

  it('keeps generateMap byte identical for the seed the server ships with', () => {
    expect(JSON.stringify(generateMap('vettai-1'))).toBe(JSON.stringify(generateMap('vettai-1')))
  })
})

describe('drones keep out of the towers', () => {
  it('never ends a step inside a building, circling or on patrol', () => {
    fc.assert(
      fc.property(
        fc.array(moveArb, { maxLength: 40, size: 'max' }),
        fc.nat({ max: crossings.length - 1 }),
        (moves, where) => {
          const start = crossings[where % crossings.length] ?? map.spawn
          const circling: DroneState = {
            id: 'd1',
            x: start.x,
            y: DRONE_Y,
            z: start.z - 10,
            yaw: 0,
            hp: 3,
            state: 'patrol',
            loop: 0,
            waypoint: 0,
            target: null,
            // Far in the future: a drone that never fires never downs its target, so it stays
            // engaged for the whole run and the orbit is what is under test.
            nextFireAt: START + 1_000_000,
            deadUntil: 0,
            damage: new Map(),
          }
          let room = addPlayer(createRoom(map, 'orbit'), 'p1', MK1, start)
          room = { ...room, drones: new Map([[circling.id, circling]]) }

          let now = START
          let ticks = 0
          for (const move of moves) {
            room = applyMove(room, 'p1', move, now)
            for (let held = 0; held < move.hold && ticks < MAX_TICKS; held++) {
              now += 50
              ticks += 1
              room = step(room, map, DT, now).room
              for (const drone of room.drones.values()) {
                for (const building of map.buildings) {
                  if (building.height <= DRONE_Y) continue
                  if (insideInflated(drone, building.aabb, DRONE_CLEARANCE)) return false
                }
              }
            }
          }
          return true
        },
      ),
      RUNS,
    )
  })
})
