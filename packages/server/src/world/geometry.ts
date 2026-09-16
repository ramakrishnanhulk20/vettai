import type { Box, Place, Vec3 } from './types.js'

/**
 * The collision and aiming maths. Nothing here knows about players, drones or time, so
 * every rule in sim.ts can be tested against a box and a point on its own.
 */

/** A body is pushed this far past the face it hit, so floating point never leaves it touching. */
const SKIN = 1e-6

/** One axis pass can push a body into a neighbouring box, so each pass repeats until still. */
const RESOLVE_PASSES = 8

/**
 * True when a body of this radius standing at x,z is inside the box. The body is treated
 * as a square rather than a circle, which is cautious at the corners on purpose: a player
 * and a drone are both kept a clear radius away from a wall.
 */
export function overlapsBox(x: number, z: number, box: Box, radius: number): boolean {
  return (
    x > box.minX - radius && x < box.maxX + radius && z > box.minZ - radius && z < box.maxZ + radius
  )
}

function insideAny(x: number, z: number, radius: number, boxes: readonly Box[]): boolean {
  for (const box of boxes) if (overlapsBox(x, z, box, radius)) return true
  return false
}

/**
 * Push a body that is already stuck out through its nearest face. This only runs when a
 * caller hands in a start position that was already inside a box, which the simulation
 * never does; it is here so one bad position cannot trap a player forever.
 */
function pushOut(at: Place, radius: number, boxes: readonly Box[]): Place {
  let { x, z } = at
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false
    for (const box of boxes) {
      if (!overlapsBox(x, z, box, radius)) continue
      const left = x - (box.minX - radius)
      const right = box.maxX + radius - x
      const back = z - (box.minZ - radius)
      const front = box.maxZ + radius - z
      const least = Math.min(left, right, back, front)
      if (least === left) x = box.minX - radius - SKIN
      else if (least === right) x = box.maxX + radius + SKIN
      else if (least === back) z = box.minZ - radius - SKIN
      else z = box.maxZ + radius + SKIN
      moved = true
    }
    if (!moved) break
  }
  return { x, z }
}

/**
 * Move a body of the given radius from one place to another, sliding along any box it
 * meets. X is moved and resolved first, then Z, which is what makes a body slide along a
 * wall instead of stopping dead at it.
 *
 * The body is treated as a square of side 2 x radius, so the result is always outside every
 * box grown by the radius. That is slightly cautious at corners and it is the guarantee the
 * property tests lean on. If a pass cannot find a free spot the move is refused and the
 * start position comes back, so no input sequence can end inside a building.
 */
export function slideAgainstBoxes(
  from: Place,
  to: Place,
  radius: number,
  boxes: readonly Box[],
): Place {
  let x = to.x
  let z = from.z
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false
    for (const box of boxes) {
      if (!overlapsBox(x, z, box, radius)) continue
      if (to.x > from.x) x = box.minX - radius - SKIN
      else if (to.x < from.x) x = box.maxX + radius + SKIN
      else x = x - box.minX < box.maxX - x ? box.minX - radius - SKIN : box.maxX + radius + SKIN
      moved = true
    }
    if (!moved) break
  }

  z = to.z
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false
    for (const box of boxes) {
      if (!overlapsBox(x, z, box, radius)) continue
      if (to.z > from.z) z = box.minZ - radius - SKIN
      else if (to.z < from.z) z = box.maxZ + radius + SKIN
      else z = z - box.minZ < box.maxZ - z ? box.minZ - radius - SKIN : box.maxZ + radius + SKIN
      moved = true
    }
    if (!moved) break
  }

  if (!insideAny(x, z, radius, boxes)) return { x, z }
  if (!insideAny(from.x, from.z, radius, boxes)) return { x: from.x, z: from.z }
  return pushOut(from, radius, boxes)
}

function closestOnSegment(a: Vec3, b: Vec3, point: Vec3): Vec3 {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const lengthSquared = abx * abx + aby * aby + abz * abz
  if (lengthSquared === 0) return a
  let t = ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / lengthSquared
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return { x: a.x + abx * t, y: a.y + aby * t, z: a.z + abz * t }
}

function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

/**
 * True when the line between a and b passes through a building. The box is the footprint and
 * `minY` to `maxY` is how tall it stands, so a shot that clears the roof is not blocked.
 * This is the slab test: each axis gives the slice of the line that is inside the box, and
 * all three slices have to overlap for the line to be inside the box at any point.
 */
export function segmentHitsBox(a: Vec3, b: Vec3, aabb: Box, minY: number, maxY: number): boolean {
  const slabs: [number, number, number, number][] = [
    [a.x, b.x - a.x, aabb.minX, aabb.maxX],
    [a.y, b.y - a.y, minY, maxY],
    [a.z, b.z - a.z, aabb.minZ, aabb.maxZ],
  ]

  let near = 0
  let far = 1
  for (const [start, delta, low, high] of slabs) {
    if (Math.abs(delta) < 1e-12) {
      if (start < low || start > high) return false
      continue
    }
    const first = (low - start) / delta
    const second = (high - start) / delta
    near = Math.max(near, Math.min(first, second))
    far = Math.min(far, Math.max(first, second))
    if (near > far) return false
  }
  return true
}

/**
 * The nearest target inside a cone around `dir`, used for aim assist on a phone screen.
 * `coneRadians` is the half angle: a target is counted when the angle between `dir` and the
 * line to it is at or below that. `dir` does not have to be a unit vector. Returns null
 * when nothing is in range, and the distance so the caller can pick the closest of several
 * cones.
 */
export function rayConeNearest<T extends Vec3>(
  origin: Vec3,
  dir: Vec3,
  coneRadians: number,
  range: number,
  targets: readonly T[],
): { target: T; distance: number } | null {
  const dirLength = Math.hypot(dir.x, dir.y, dir.z)
  if (dirLength === 0) return null

  const minCosine = Math.cos(coneRadians)
  let best: { target: T; distance: number } | null = null
  for (const target of targets) {
    const vx = target.x - origin.x
    const vy = target.y - origin.y
    const vz = target.z - origin.z
    const distance = Math.hypot(vx, vy, vz)
    if (distance > range) continue
    if (distance > 0) {
      const cosine = (vx * dir.x + vy * dir.y + vz * dir.z) / (distance * dirLength)
      if (cosine < minCosine) continue
    }
    if (best === null || distance < best.distance) best = { target, distance }
  }
  return best
}

/**
 * True when a sphere touches an upright capsule. The capsule is a body: `base` is on the
 * ground at the feet, `height` is how tall it stands, and the ends are rounded by
 * `capsuleRadius`, which is why a bolt at head height still counts as a hit.
 */
export function capsuleHitBySphere(
  base: Vec3,
  height: number,
  capsuleRadius: number,
  centre: Vec3,
  sphereRadius: number,
): boolean {
  const top = { x: base.x, y: base.y + height, z: base.z }
  const reach = capsuleRadius + sphereRadius
  const closest = closestOnSegment(base, top, centre)
  return distanceSquared(closest, centre) <= reach * reach
}
