// Covers the scripted player's own maths on fixed states: where it points to hit a drone,
// which drone it picks, and when a bolt is worth stepping out of the way of. It does NOT
// cover a real run against a server, the socket, or whether the bot is any good at the
// game: prove.ts plays it for real and reports the kills it got.

import { describe, expect, it } from 'vitest'
import {
  aimAt,
  canSee,
  dodgeFrom,
  horizontalRange,
  pickTarget,
  stepToward,
  type TrackedBolt,
} from '../src/cli/bot.js'
import type { DroneWire } from '../src/world/rooms.js'
import type { Vec3, WorldMap } from '../src/world/types.js'

const EYE = { x: 0, y: 1.6, z: 0 }

/** The exact vector the simulation builds out of a yaw and a pitch, copied from sim.ts. */
function aimVector(yaw: number, pitch: number): Vec3 {
  const flat = Math.cos(pitch)
  return { x: Math.sin(yaw) * flat, y: Math.sin(pitch), z: Math.cos(yaw) * flat }
}

function angleBetween(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  const lengths = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z)
  return Math.acos(Math.min(1, Math.max(-1, dot / lengths)))
}

function drone(id: string, x: number, y: number, z: number, extra: Partial<DroneWire> = {}): DroneWire {
  return { id, x, y, z, yaw: 0, hp: 3, state: 'patrol', ...extra }
}

function mapWith(buildings: WorldMap['buildings']): WorldMap {
  return {
    version: 'test',
    size: 288,
    lotSize: 16,
    street: 8,
    buildings,
    parks: [],
    office: { x: 0, z: 0 },
    shop: { x: 0, z: 10 },
    landmarks: [
      { x: -100, z: -100 },
      { x: 100, z: -100 },
      { x: -100, z: 100 },
      { x: 100, z: 100 },
    ],
    courier: Array.from({ length: 8 }, (_, n) => ({ x: n * 4, z: 0 })) as WorldMap['courier'],
    patrols: [],
    spawn: { x: 0, z: 0 },
  }
}

const EMPTY_MAP = mapWith([])

describe('aimAt', () => {
  it('points straight down +z for a target directly ahead', () => {
    const aim = aimAt(EYE, { x: 0, y: 1.6, z: 20 })
    expect(aim.yaw).toBeCloseTo(0, 6)
    expect(aim.pitch).toBeCloseTo(0, 6)
  })

  it('points a quarter turn right for a target on +x', () => {
    const aim = aimAt(EYE, { x: 20, y: 1.6, z: 0 })
    expect(aim.yaw).toBeCloseTo(Math.PI / 2, 6)
  })

  it('looks up at a drone flying overhead', () => {
    const aim = aimAt(EYE, { x: 0, y: 6, z: 4.4 })
    expect(aim.pitch).toBeCloseTo(Math.PI / 4, 6)
  })

  it('lands inside the simulation aim cone for a drone at patrol height and range', () => {
    const target = { x: 31.5, y: 6, z: -18.25 }
    const aim = aimAt(EYE, target)
    const wanted = { x: target.x - EYE.x, y: target.y - EYE.y, z: target.z - EYE.z }

    // The simulation counts a hit inside the aim cone; this has to be a direct hit, not a
    // shot that only just scrapes in, or a drone that moved would be missed.
    expect(angleBetween(aimVector(aim.yaw, aim.pitch), wanted)).toBeLessThan(1e-9)
  })
})

describe('pickTarget', () => {
  it('takes the nearest live drone', () => {
    const chosen = pickTarget(EMPTY_MAP, { x: 0, z: 0 }, [
      drone('far', 0, 6, 40),
      drone('near', 0, 6, 12),
    ])
    expect(chosen?.id).toBe('near')
  })

  it('leaves a wreck alone', () => {
    const chosen = pickTarget(EMPTY_MAP, { x: 0, z: 0 }, [
      drone('wreck', 0, 6, 5, { state: 'dead', hp: 0 }),
      drone('alive', 0, 6, 30),
    ])
    expect(chosen?.id).toBe('alive')
  })

  it('skips a near drone behind a tower and takes the one it can see', () => {
    const tower = {
      lot: [0, 0] as [number, number],
      type: 0,
      height: 40,
      aabb: { minX: -5, minZ: 5, maxX: 5, maxZ: 15 },
    }
    const map = mapWith([tower])

    expect(canSee(map, EYE, { x: 0, y: 6, z: 20 })).toBe(false)
    const chosen = pickTarget(map, { x: 0, z: 0 }, [drone('hidden', 0, 6, 20), drone('clear', 30, 6, 0)])
    expect(chosen?.id).toBe('clear')
  })

  it('answers with nothing when every drone is dead', () => {
    expect(pickTarget(EMPTY_MAP, { x: 0, z: 0 }, [drone('gone', 0, 6, 5, { state: 'dead', hp: 0 })])).toBeNull()
  })
})

describe('dodgeFrom', () => {
  const bolt = (over: Partial<TrackedBolt> = {}): TrackedBolt => ({
    id: 'b1',
    x: 0,
    y: 1,
    z: -12,
    vx: 0,
    vz: 12,
    ...over,
  })

  it('steps sideways out of a bolt coming straight at the player', () => {
    const move = dodgeFrom({ x: 0.2, z: 0 }, [bolt()])
    expect(move).not.toBeNull()
    // The bolt runs along +z, so the only way out is along x, and towards the side the
    // player already stands on.
    expect(Math.abs(move?.dx ?? 0)).toBeCloseTo(1, 6)
    expect(move?.dz).toBeCloseTo(0, 6)
    expect(move?.dx).toBeGreaterThan(0)
  })

  it('steps the other way when the player is on the other side of the line', () => {
    const move = dodgeFrom({ x: -0.2, z: 0 }, [bolt()])
    expect(move?.dx).toBeLessThan(0)
  })

  it('ignores a bolt that will miss by a comfortable margin', () => {
    expect(dodgeFrom({ x: 6, z: 0 }, [bolt()])).toBeNull()
  })

  it('ignores a bolt that has already gone past', () => {
    expect(dodgeFrom({ x: 0, z: 0 }, [bolt({ z: 8, vz: 12 })])).toBeNull()
  })

  it('ignores a bolt that is still seconds away', () => {
    expect(dodgeFrom({ x: 0, z: 0 }, [bolt({ z: -40, vz: 12 })])).toBeNull()
  })

  it('ignores a sighting with no measured speed, because one frame proves no direction', () => {
    expect(dodgeFrom({ x: 0, z: 0 }, [bolt({ vx: 0, vz: 0 })])).toBeNull()
  })
})

describe('stepToward', () => {
  it('returns a unit vector towards the target', () => {
    const step = stepToward({ x: 0, z: 0 }, { x: 3, z: 4 })
    expect(Math.hypot(step.dx, step.dz)).toBeCloseTo(1, 6)
    expect(step.dx).toBeCloseTo(0.6, 6)
    expect(step.dz).toBeCloseTo(0.8, 6)
  })

  it('stands still when it is already there', () => {
    expect(stepToward({ x: 5, z: 5 }, { x: 5, z: 5 })).toEqual({ dx: 0, dz: 0 })
  })
})

describe('horizontalRange', () => {
  it('ignores height, because walking is flat', () => {
    expect(horizontalRange({ x: 0, z: 0 }, { x: 3, z: 4 })).toBeCloseTo(5, 6)
  })
})
