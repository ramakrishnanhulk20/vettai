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
const GENERATOR_VERSION = 3

export const LOTS_PER_SIDE = 12
export const LOT_SIZE = 16
export const STREET = 8
const CELL = LOT_SIZE + STREET
export const MAP_SIZE = LOTS_PER_SIDE * CELL
const HALF = MAP_SIZE / 2

/** Drones fly their loops at this height, above heads and below the roofs. */
export const PATROL_Y = 6

/**
 * The quest board stands in a no-fire circle this wide. Nothing may shoot into it and
 * nobody may shoot out of it, so it is a place to read the board from and come back at,
 * never a place to camp from.
 */
export const OFFICE_SAFE_RADIUS = 10

/**
 * How far a patrol waypoint has to stay from the board. A drone that flew into the circle
 * could be taken apart by a player standing in the one spot nothing is allowed to shoot
 * back at, which is a farm rather than a fight.
 */
const PATROL_BOARD_CLEARANCE = OFFICE_SAFE_RADIUS + 4

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
/**
 * Four loops over the quarters of the block and one short loop over the four centre blocks
 * around the office. The centre loop is last, and drones are handed out to the loops in
 * turn, so a player who has just spawned always has a couple of drones inside 60 m.
 */
const PATROL_QUADRANTS: [number, number, number, number][] = [
  [1, 5, 1, 5],
  [6, 10, 1, 5],
  [1, 5, 6, 10],
  [6, 10, 6, 10],
  [CENTRE_LOT - 1, CENTRE_LOT + 1, CENTRE_LOT - 1, CENTRE_LOT + 1],
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

const OFFICE_LOT: Lot = [CENTRE_LOT, CENTRE_LOT]
const OFFICE = crossing(OFFICE_LOT)

function insideGrid(index: number): number {
  return Math.min(LOTS_PER_SIDE - 1, Math.max(0, index))
}

/** The same lot, or one stepped away from the board when its crossing is inside the circle. */
function clearOfBoard(lot: Lot): Lot {
  if (Math.hypot(crossing(lot).x - OFFICE.x, crossing(lot).z - OFFICE.z) >= PATROL_BOARD_CLEARANCE) {
    return lot
  }

  // Crossings are a whole cell apart, so only the board's own lot can be this close and one
  // step out of it is 24 m, which always clears the circle. A lot on the centre goes east.
  const alongI = Math.sign(lot[0] - OFFICE_LOT[0])
  const alongJ = Math.sign(lot[1] - OFFICE_LOT[1])
  const stepI = alongI === 0 && alongJ === 0 ? 1 : alongI
  return [insideGrid(lot[0] + stepI), insideGrid(lot[1] + alongJ)]
}

/** Drops a waypoint that repeats the one before it, and a last one that repeats the first. */
function withoutRepeats(lots: Lot[]): Lot[] {
  const kept: Lot[] = []
  for (const lot of lots) {
    const last = kept[kept.length - 1]
    if (last && last[0] === lot[0] && last[1] === lot[1]) continue
    kept.push(lot)
  }

  const first = kept[0]
  const end = kept[kept.length - 1]
  if (kept.length > 1 && first && end && first[0] === end[0] && first[1] === end[1]) kept.pop()
  return kept
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
 * crossing, so a drone flying the loop never crosses a roof. None of them sits inside the
 * board's circle, and no two in a row are the same place.
 */
function patrolLoop(quadrant: [number, number, number, number], rng: () => number): PatrolLoop {
  const [baseI1, i2, baseJ1, j2] = quadrant
  // The jitter may not eat the whole span. With fewer than two cells between the corners
  // the midpoint lands on a corner, and the loop then asks a drone to fly where it is.
  const i1 = Math.min(baseI1 + Math.floor(rng() * 2), i2 - 2)
  const j1 = Math.min(baseJ1 + Math.floor(rng() * 2), j2 - 2)
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
  return withoutRepeats(corners.map(clearOfBoard)).map(crossing)
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

  const office = OFFICE
  const shop = crossing([CENTRE_LOT + 2, CENTRE_LOT])
  /**
   * In tour order, near first. Two sit in the middle ring and two on the far corners, which
   * keeps the whole round trip from the spawn under 450 m of street: four corners cost 834 m
   * and nearly two and a half minutes of walking for a quest that pays less than one drone.
   */
  const landmarks: [Place, Place, Place, Place] = [
    crossing([CENTRE_LOT, CENTRE_LOT + 1]),
    crossing([3, LOTS_PER_SIDE - 4]),
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
    // On the office door: two metres short of it, on the same street, looking down +z at
    // it, so the interact prompt is already on screen in the first frame a player sees.
    spawn: { x: office.x, z: office.z - 2 },
  }
}
