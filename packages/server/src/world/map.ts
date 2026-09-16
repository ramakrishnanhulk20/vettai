import { hashSeed, seeded } from './prng.js'
import type { Building, Lot, PatrolLoop, Place, WorldMap } from './types.js'

/**
 * The city, generated from a string seed. The server and the client both call this with
 * MAP_SEED and get the same JSON, so nothing about the block is hardcoded on either side.
 *
 * The grid is 12 by 12 cells of 24 m. Each cell holds an 8 m street strip and then a 16 m
 * lot, which is why a street centre line is always 4 m in from a cell edge and why a point
 * sitting on a centre line can never be inside a building.
 */

/** Bump this when the shape of the map changes, so a stale client refuses to draw it. */
const GENERATOR_VERSION = 1

export const LOTS_PER_SIDE = 12
export const LOT_SIZE = 16
export const STREET = 8
const CELL = LOT_SIZE + STREET
export const MAP_SIZE = LOTS_PER_SIDE * CELL
const HALF = MAP_SIZE / 2

/** Drones fly their loops at this height, above heads and below the roofs. */
export const PATROL_Y = 6

const BUILDING_SHARE = 0.6
const PARK_SHARE = 0.15
const MIN_HEIGHT = 8
const MAX_HEIGHT = 40
const TYPE_COUNT = 20

const CENTRE_LOT = LOTS_PER_SIDE / 2
const COURIER_CROSSINGS: Lot[] = [
  [2, 2],
  [9, 2],
  [2, 9],
  [9, 9],
  [6, 1],
  [1, 6],
  [10, 6],
  [6, 10],
]
const PATROL_QUADRANTS: [number, number, number, number][] = [
  [1, 5, 1, 5],
  [6, 10, 1, 5],
  [1, 5, 6, 10],
  [6, 10, 6, 10],
]

/** The middle of the street strip in cell `index`, on either axis. */
export function streetCentre(index: number): number {
  return -HALF + index * CELL + STREET / 2
}

function lotBox(i: number, j: number) {
  const minX = -HALF + i * CELL + STREET
  const minZ = -HALF + j * CELL + STREET
  return { minX, minZ, maxX: minX + LOT_SIZE, maxZ: minZ + LOT_SIZE }
}

function round(value: number, places: number): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

function crossing(lot: Lot): Place {
  return { x: streetCentre(lot[0]), z: streetCentre(lot[1]) }
}

function shuffle(lots: Lot[], rng: () => number): void {
  for (let n = lots.length - 1; n > 0; n--) {
    const swap = Math.floor(rng() * (n + 1))
    const a = lots[n]
    const b = lots[swap]
    if (a === undefined || b === undefined) continue
    lots[n] = b
    lots[swap] = a
  }
}

function key(i: number, j: number): number {
  return i * LOTS_PER_SIDE + j
}

function pickType(i: number, j: number, types: Map<number, number>, rng: () => number): number {
  const taken = new Set<number>()
  for (const [ni, nj] of [
    [i - 1, j],
    [i + 1, j],
    [i, j - 1],
    [i, j + 1],
  ] as [number, number][]) {
    const neighbour = types.get(key(ni, nj))
    if (neighbour !== undefined) taken.add(neighbour)
  }
  const free: number[] = []
  for (let type = 0; type < TYPE_COUNT; type++) if (!taken.has(type)) free.push(type)
  const chosen = free[Math.floor(rng() * free.length)]
  return chosen ?? Math.floor(rng() * TYPE_COUNT)
}

/**
 * A loop around one quarter of the block: eight waypoints, every one of them a street
 * crossing, so a drone flying the loop never crosses a roof.
 */
function patrolLoop(quadrant: [number, number, number, number], rng: () => number): PatrolLoop {
  const [baseI1, i2, baseJ1, j2] = quadrant
  const i1 = baseI1 + Math.floor(rng() * 2)
  const j1 = baseJ1 + Math.floor(rng() * 2)
  const im = Math.floor((i1 + i2) / 2)
  const jm = Math.floor((j1 + j2) / 2)
  const corners: Lot[] = [
    [i1, j1],
    [im, j1],
    [i2, j1],
    [i2, jm],
    [i2, j2],
    [im, j2],
    [i1, j2],
    [i1, jm],
  ]
  return corners.map(crossing)
}

function courierPoint(lot: Lot, index: number, rng: () => number): Place {
  const spread = round((rng() * 2 - 1) * 6, 2)
  const at = crossing(lot)
  const limit = HALF - 3
  const slide = (value: number) => Math.min(limit, Math.max(-limit, round(value + spread, 2)))
  return index % 2 === 0 ? { x: at.x, z: slide(at.z) } : { x: slide(at.x), z: at.z }
}

export function generateMap(seed: string): WorldMap {
  const rng = seeded(`${seed}:map:${GENERATOR_VERSION}`)

  const lots: Lot[] = []
  for (let i = 0; i < LOTS_PER_SIDE; i++) {
    for (let j = 0; j < LOTS_PER_SIDE; j++) lots.push([i, j])
  }
  shuffle(lots, rng)

  const buildingCount = Math.round(lots.length * BUILDING_SHARE)
  const parkCount = Math.round(lots.length * PARK_SHARE)
  const isBuilding = new Set<number>()
  const parkSet = new Set<number>()
  lots.forEach((lot, index) => {
    if (index < buildingCount) isBuilding.add(key(lot[0], lot[1]))
    else if (index < buildingCount + parkCount) parkSet.add(key(lot[0], lot[1]))
  })

  const types = new Map<number, number>()
  const buildings: Building[] = []
  const parks: Lot[] = []
  for (let i = 0; i < LOTS_PER_SIDE; i++) {
    for (let j = 0; j < LOTS_PER_SIDE; j++) {
      if (parkSet.has(key(i, j))) parks.push([i, j])
      if (!isBuilding.has(key(i, j))) continue
      const type = pickType(i, j, types, rng)
      types.set(key(i, j), type)
      const height = round(MIN_HEIGHT + rng() * (MAX_HEIGHT - MIN_HEIGHT), 1)
      buildings.push({ lot: [i, j], type, height, aabb: lotBox(i, j) })
    }
  }

  const office = crossing([CENTRE_LOT, CENTRE_LOT])
  const shop = crossing([CENTRE_LOT + 2, CENTRE_LOT])
  const landmarks: [Place, Place, Place, Place] = [
    crossing([1, 1]),
    crossing([LOTS_PER_SIDE - 2, 1]),
    crossing([1, LOTS_PER_SIDE - 2]),
    crossing([LOTS_PER_SIDE - 2, LOTS_PER_SIDE - 2]),
  ]

  const points = COURIER_CROSSINGS.map((lot, index) => courierPoint(lot, index, rng))
  const [c0, c1, c2, c3, c4, c5, c6, c7] = points
  if (!c0 || !c1 || !c2 || !c3 || !c4 || !c5 || !c6 || !c7) {
    throw new Error('the map needs eight courier points')
  }

  return {
    version: `${GENERATOR_VERSION}-${hashSeed(seed).toString(36)}`,
    size: MAP_SIZE,
    lotSize: LOT_SIZE,
    street: STREET,
    buildings,
    parks,
    office,
    shop,
    landmarks,
    courier: [c0, c1, c2, c3, c4, c5, c6, c7],
    patrols: PATROL_QUADRANTS.map((quadrant) => patrolLoop(quadrant, rng)),
    // The office front: six metres up the street that runs past the quest board.
    spawn: { x: office.x, z: office.z + 6 },
  }
}
