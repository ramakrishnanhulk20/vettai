// Covers the seeded generator and the city it draws. It does NOT cover how the map is
// served or cached, and it does NOT claim the block looks good: it only proves the numbers
// are the same everywhere and that nothing a player has to reach is stuck inside a wall.

import { describe, expect, it } from 'vitest'
import {
  LOTS_PER_SIDE,
  LOT_SIZE,
  MAP_SIZE,
  STREET,
  generateMap,
  streetCentre,
} from '../src/world/map.js'
import { seeded } from '../src/world/prng.js'
import type { Box, Place, WorldMap } from '../src/world/types.js'

const PLAYER_RADIUS = 0.5
const CENTRE_LINES = Array.from({ length: LOTS_PER_SIDE }, (_, index) => streetCentre(index))

function draws(seed: string, count: number): number[] {
  const rng = seeded(seed)
  return Array.from({ length: count }, () => rng())
}

function insideInflated(place: Place, box: Box, radius: number): boolean {
  return (
    place.x > box.minX - radius &&
    place.x < box.maxX + radius &&
    place.z > box.minZ - radius &&
    place.z < box.maxZ + radius
  )
}

function fixedPlaces(map: WorldMap): Place[] {
  return [map.office, map.shop, map.spawn, ...map.landmarks, ...map.courier, ...map.patrols.flat()]
}

describe('seeded', () => {
  it('gives the same sequence for the same seed', () => {
    expect(draws('vettai-1', 8)).toEqual(draws('vettai-1', 8))
  })

  it('gives a different sequence for a different seed', () => {
    expect(draws('vettai-1', 8)).not.toEqual(draws('vettai-2', 8))
  })

  it('stays inside [0, 1)', () => {
    for (const value of draws('vettai-1', 2000)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('generateMap', () => {
  const map = generateMap('vettai-1')

  it('draws the same city twice from one seed', () => {
    expect(JSON.stringify(generateMap('vettai-1'))).toBe(JSON.stringify(map))
  })

  it('draws a different city from a different seed', () => {
    expect(JSON.stringify(generateMap('vettai-2'))).not.toBe(JSON.stringify(map))
  })

  it('stamps a version that moves with the seed', () => {
    expect(map.version).toMatch(/^1-[0-9a-z]+$/)
    expect(generateMap('vettai-2').version).not.toBe(map.version)
  })

  it('keeps the grid the client expects', () => {
    expect(map.size).toBe(MAP_SIZE)
    expect(map.size).toBe(288)
    expect(map.lotSize).toBe(LOT_SIZE)
    expect(map.street).toBe(STREET)
  })

  it('builds on about six lots in ten and leaves the rest open', () => {
    const lots = LOTS_PER_SIDE * LOTS_PER_SIDE
    const share = map.buildings.length / lots
    expect(share).toBeGreaterThan(0.55)
    expect(share).toBeLessThan(0.65)
    expect(map.parks.length).toBeGreaterThan(0)

    const taken = new Set(map.buildings.map((building) => building.lot.join(',')))
    expect(taken.size).toBe(map.buildings.length)
    for (const park of map.parks) expect(taken.has(park.join(','))).toBe(false)
  })

  it('puts every building on its own lot inside the map', () => {
    const half = MAP_SIZE / 2
    for (const building of map.buildings) {
      expect(building.aabb.maxX - building.aabb.minX).toBe(LOT_SIZE)
      expect(building.aabb.maxZ - building.aabb.minZ).toBe(LOT_SIZE)
      expect(building.aabb.minX).toBeGreaterThanOrEqual(-half)
      expect(building.aabb.minZ).toBeGreaterThanOrEqual(-half)
      expect(building.aabb.maxX).toBeLessThanOrEqual(half)
      expect(building.aabb.maxZ).toBeLessThanOrEqual(half)
    }
  })

  it('keeps heights and types in the range the client can draw', () => {
    for (const building of map.buildings) {
      expect(building.height).toBeGreaterThanOrEqual(8)
      expect(building.height).toBeLessThanOrEqual(40)
      expect(Number.isInteger(building.type)).toBe(true)
      expect(building.type).toBeGreaterThanOrEqual(0)
      expect(building.type).toBeLessThan(20)
    }
  })

  it('never puts the same building type next to itself', () => {
    const types = new Map<string, number>()
    for (const building of map.buildings) types.set(building.lot.join(','), building.type)
    for (const building of map.buildings) {
      const [i, j] = building.lot
      for (const [ni, nj] of [
        [i + 1, j],
        [i, j + 1],
      ]) {
        const neighbour = types.get(`${ni},${nj}`)
        if (neighbour !== undefined) expect(neighbour).not.toBe(building.type)
      }
    }
  })

  it('leaves every fixed place clear of every building', () => {
    for (const place of fixedPlaces(map)) {
      for (const building of map.buildings) {
        expect(insideInflated(place, building.aabb, PLAYER_RADIUS)).toBe(false)
      }
    }
  })

  it('has the quest board, the shop and the spawn on the street', () => {
    expect(CENTRE_LINES).toContain(map.office.x)
    expect(CENTRE_LINES).toContain(map.office.z)
    expect(CENTRE_LINES).toContain(map.shop.x)
    expect(CENTRE_LINES).toContain(map.shop.z)
    expect(map.spawn.x).toBe(map.office.x)
    expect(Math.abs(map.spawn.z - map.office.z)).toBeLessThanOrEqual(STREET)
  })

  it('counts four landmarks and eight courier points, all spread out', () => {
    expect(map.landmarks).toHaveLength(4)
    expect(map.courier).toHaveLength(8)
    for (let a = 0; a < map.courier.length; a++) {
      for (let b = a + 1; b < map.courier.length; b++) {
        const first = map.courier[a]
        const second = map.courier[b]
        if (!first || !second) throw new Error('a courier point is missing')
        expect(Math.hypot(first.x - second.x, first.z - second.z)).toBeGreaterThan(20)
      }
    }
  })

  it('flies at least four patrol loops of six to ten waypoints', () => {
    expect(map.patrols.length).toBeGreaterThanOrEqual(4)
    for (const loop of map.patrols) {
      expect(loop.length).toBeGreaterThanOrEqual(6)
      expect(loop.length).toBeLessThanOrEqual(10)
    }
  })

  it('puts every patrol waypoint on a street crossing', () => {
    for (const loop of map.patrols) {
      for (const waypoint of loop) {
        expect(CENTRE_LINES).toContain(waypoint.x)
        expect(CENTRE_LINES).toContain(waypoint.z)
      }
    }
  })
})
