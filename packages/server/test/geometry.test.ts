// Covers the collision and aiming maths on its own. It does NOT cover any game rule: speed,
// fire rate, damage and drone behaviour live in sim.test.ts, and nothing here knows about
// time, so a fast body tunnelling between two ticks is the caller's problem to avoid.

import { describe, expect, it } from 'vitest'
import {
  capsuleHitBySphere,
  rayConeNearest,
  segmentHitsBox,
  slideAgainstBoxes,
} from '../src/world/geometry.js'

const WALL = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }
const RADIUS = 0.5

describe('slideAgainstBoxes', () => {
  it('leaves a move that touches nothing alone', () => {
    const moved = slideAgainstBoxes({ x: -20, z: -20 }, { x: -18, z: -17 }, RADIUS, [WALL])
    expect(moved.x).toBe(-18)
    expect(moved.z).toBe(-17)
  })

  it('stops a body flush against the face it walked into', () => {
    const moved = slideAgainstBoxes({ x: -2, z: 5 }, { x: 1, z: 5 }, RADIUS, [WALL])
    expect(moved.x).toBeCloseTo(-RADIUS, 4)
    expect(moved.x).toBeLessThan(-RADIUS)
    expect(moved.z).toBe(5)
  })

  it('slides along the wall when the move is diagonal', () => {
    const moved = slideAgainstBoxes({ x: -2, z: 5 }, { x: 1, z: 8 }, RADIUS, [WALL])
    expect(moved.x).toBeCloseTo(-RADIUS, 4)
    expect(moved.z).toBe(8)
  })

  it('walks down the gap between two boxes without touching either', () => {
    const across = { minX: 0, minZ: 12, maxX: 10, maxZ: 20 }
    const moved = slideAgainstBoxes({ x: -2, z: 11 }, { x: 5, z: 11 }, RADIUS, [WALL, across])
    expect(moved.x).toBe(5)
    expect(moved.z).toBe(11)
  })

  it('pushes a body that starts inside a box back out of it', () => {
    const moved = slideAgainstBoxes({ x: 1, z: 5 }, { x: 1.2, z: 5 }, RADIUS, [WALL])
    const inside =
      moved.x > WALL.minX - RADIUS &&
      moved.x < WALL.maxX + RADIUS &&
      moved.z > WALL.minZ - RADIUS &&
      moved.z < WALL.maxZ + RADIUS
    expect(inside).toBe(false)
  })
})

describe('segmentHitsBox', () => {
  const eye = { x: -5, y: 1.6, z: 5 }

  it('blocks a shot that runs into a tall building', () => {
    expect(segmentHitsBox(eye, { x: 20, y: 6, z: 5 }, WALL, 0, 30)).toBe(true)
  })

  it('lets a shot pass over a low building', () => {
    expect(segmentHitsBox(eye, { x: 20, y: 6, z: 5 }, WALL, 0, 2)).toBe(false)
  })

  it('lets a shot pass beside a building', () => {
    expect(
      segmentHitsBox({ x: -5, y: 1.6, z: -4 }, { x: 20, y: 6, z: -4 }, WALL, 0, 30),
    ).toBe(false)
  })

  it('does not block a shot that stops before the building', () => {
    expect(segmentHitsBox(eye, { x: -2, y: 2, z: 5 }, WALL, 0, 30)).toBe(false)
  })
})

describe('rayConeNearest', () => {
  const origin = { x: 0, y: 1.6, z: 0 }
  const forward = { x: 0, y: 0, z: 1 }
  const cone = (6 * Math.PI) / 180

  it('takes the nearest target inside the cone', () => {
    const far = { id: 'far', x: 0, y: 1.6, z: 30 }
    const near = { id: 'near', x: 0.5, y: 1.6, z: 20 }
    const found = rayConeNearest(origin, forward, cone, 60, [far, near])
    expect(found?.target.id).toBe('near')
    expect(found?.distance).toBeCloseTo(20.006, 2)
  })

  it('refuses a target outside the cone', () => {
    const wide = { id: 'wide', x: 20, y: 1.6, z: 20 }
    expect(rayConeNearest(origin, forward, cone, 60, [wide])).toBeNull()
  })

  it('refuses a target past the range', () => {
    const far = { id: 'far', x: 0, y: 1.6, z: 70 }
    expect(rayConeNearest(origin, forward, cone, 60, [far])).toBeNull()
  })

  it('reports nothing for an empty list or a zero aim', () => {
    expect(rayConeNearest(origin, forward, cone, 60, [])).toBeNull()
    expect(rayConeNearest(origin, { x: 0, y: 0, z: 0 }, cone, 60, [{ x: 0, y: 1.6, z: 5 }])).toBeNull()
  })
})

describe('capsuleHitBySphere', () => {
  const base = { x: 0, y: 0.5, z: 0 }
  const height = 0.8
  const radius = 0.5

  it('counts a bolt that clips the body', () => {
    expect(capsuleHitBySphere(base, height, radius, { x: 0.6, y: 1, z: 0 }, 0.15)).toBe(true)
  })

  it('counts a bolt at head height, because the ends are round', () => {
    expect(capsuleHitBySphere(base, height, radius, { x: 0, y: 1.75, z: 0 }, 0.15)).toBe(true)
  })

  it('misses a bolt that passes wide', () => {
    expect(capsuleHitBySphere(base, height, radius, { x: 1.2, y: 1, z: 0 }, 0.15)).toBe(false)
  })

  it('misses a bolt that flies over the head', () => {
    expect(capsuleHitBySphere(base, height, radius, { x: 0, y: 3, z: 0 }, 0.15)).toBe(false)
  })
})
