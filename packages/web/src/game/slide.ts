import type { Box } from "./map";

/**
 * This file mirrors packages/server/src/world/geometry.ts: the client has to predict a step
 * with exactly the maths the server will use, or the player rubber-bands against a wall.
 */

const SKIN = 1e-6;
const RESOLVE_PASSES = 8;

export type Place = { x: number; z: number };
export type Vec3 = { x: number; y: number; z: number };

export function overlapsBox(x: number, z: number, box: Box, radius: number): boolean {
  return (
    x > box.minX - radius && x < box.maxX + radius && z > box.minZ - radius && z < box.maxZ + radius
  );
}

function insideAny(x: number, z: number, radius: number, boxes: readonly Box[]): boolean {
  for (const box of boxes) if (overlapsBox(x, z, box, radius)) return true;
  return false;
}

function pushOut(at: Place, radius: number, boxes: readonly Box[]): Place {
  let { x, z } = at;
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false;
    for (const box of boxes) {
      if (!overlapsBox(x, z, box, radius)) continue;
      const left = x - (box.minX - radius);
      const right = box.maxX + radius - x;
      const back = z - (box.minZ - radius);
      const front = box.maxZ + radius - z;
      const least = Math.min(left, right, back, front);
      if (least === left) x = box.minX - radius - SKIN;
      else if (least === right) x = box.maxX + radius + SKIN;
      else if (least === back) z = box.minZ - radius - SKIN;
      else z = box.maxZ + radius + SKIN;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}

/** X is moved and resolved first, then Z, which is what makes a body slide along a wall. */
export function slideAgainstBoxes(
  from: Place,
  to: Place,
  radius: number,
  boxes: readonly Box[],
): Place {
  let x = to.x;
  let z = from.z;
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false;
    for (const box of boxes) {
      if (!overlapsBox(x, z, box, radius)) continue;
      if (to.x > from.x) x = box.minX - radius - SKIN;
      else if (to.x < from.x) x = box.maxX + radius + SKIN;
      else x = x - box.minX < box.maxX - x ? box.minX - radius - SKIN : box.maxX + radius + SKIN;
      moved = true;
    }
    if (!moved) break;
  }

  z = to.z;
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false;
    for (const box of boxes) {
      if (!overlapsBox(x, z, box, radius)) continue;
      if (to.z > from.z) z = box.minZ - radius - SKIN;
      else if (to.z < from.z) z = box.maxZ + radius + SKIN;
      else z = z - box.minZ < box.maxZ - z ? box.minZ - radius - SKIN : box.maxZ + radius + SKIN;
      moved = true;
    }
    if (!moved) break;
  }

  if (!insideAny(x, z, radius, boxes)) return { x, z };
  if (!insideAny(from.x, from.z, radius, boxes)) return { x: from.x, z: from.z };
  return pushOut(from, radius, boxes);
}

/**
 * The share of the line that is inside one pair of planes, narrowing the run kept so far.
 * The two numbers live outside the call: this is the innermost thing the aim assist does,
 * once per building per drone per frame, and an array of tuples per call was the largest
 * thing the frame handed to the garbage collector.
 */
let near = 0;
let far = 1;

function narrow(start: number, delta: number, low: number, high: number): boolean {
  if (Math.abs(delta) < 1e-12) return start >= low && start <= high;
  const first = (low - start) / delta;
  const second = (high - start) / delta;
  if (first < second) {
    if (first > near) near = first;
    if (second < far) far = second;
  } else {
    if (second > near) near = second;
    if (first < far) far = first;
  }
  return near <= far;
}

/**
 * The slab test, as on the server: the share of the line inside the box on each axis, and
 * all three shares have to overlap for the line to touch the box. `minY` to `maxY` is how
 * tall the building stands, so a shot over the roof is not blocked.
 */
export function segmentHitsBox(
  a: Vec3,
  b: Vec3,
  aabb: Box,
  minY: number,
  maxY: number,
): boolean {
  near = 0;
  far = 1;
  if (!narrow(a.x, b.x - a.x, aabb.minX, aabb.maxX)) return false;
  if (!narrow(a.y, b.y - a.y, minY, maxY)) return false;
  return narrow(a.z, b.z - a.z, aabb.minZ, aabb.maxZ);
}

/** The nearest target inside a cone around `dir`. `coneRadians` is the half angle. */
export function rayConeNearest<T extends Vec3>(
  origin: Vec3,
  dir: Vec3,
  coneRadians: number,
  range: number,
  targets: readonly T[],
): { target: T; distance: number } | null {
  const dirLength = Math.hypot(dir.x, dir.y, dir.z);
  if (dirLength === 0) return null;

  const minCosine = Math.cos(coneRadians);
  let best: { target: T; distance: number } | null = null;
  for (const target of targets) {
    const vx = target.x - origin.x;
    const vy = target.y - origin.y;
    const vz = target.z - origin.z;
    const distance = Math.hypot(vx, vy, vz);
    if (distance > range) continue;
    if (distance > 0) {
      const cosine = (vx * dir.x + vy * dir.y + vz * dir.z) / (distance * dirLength);
      if (cosine < minCosine) continue;
    }
    if (best === null || distance < best.distance) best = { target, distance };
  }
  return best;
}
