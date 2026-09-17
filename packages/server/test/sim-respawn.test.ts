// Covers where a downed player comes back: the chooser on its own, and the same choice
// made by a full tick of the world. It does NOT cover the three second downed timer or the
// shield that comes back with them, which sim.test.ts proves.

import { describe, expect, it } from 'vitest'
import { crossings, generateMap, OFFICE_SAFE_RADIUS } from '../src/world/map.js'
import { addPlayer, createRoom, respawnPoint, RESPAWN_OFFICE_CLEARANCE, step } from '../src/world/sim.js'
import type { Place, RoomState, WorldMap } from '../src/world/types.js'

const map: WorldMap = generateMap('vettai-test')
const START = 1_700_000_000_000
const DT = 0.05
const GEAR = { blaster: 'mk1' as const, skin: 'default' }

function toOffice(at: Place): number {
  return Math.hypot(at.x - map.office.x, at.z - map.office.z)
}

function isCrossing(at: Place): boolean {
  return crossings(map).some((place) => place.x === at.x && place.z === at.z)
}

function quietRoom(): RoomState {
  return {
    ...createRoom(map, 'respawn', 0),
    drones: new Map(),
    nextDroneSpawnAt: Number.MAX_SAFE_INTEGER,
  }
}

describe('where a downed player comes back', () => {
  it('puts a player who fell in the far corner on a crossing beside them', () => {
    const fell = { x: 100, z: 100 }
    const back = respawnPoint(map, fell)

    expect(isCrossing(back)).toBe(true)
    expect(Math.hypot(back.x - fell.x, back.z - fell.z)).toBeLessThanOrEqual(map.lotSize + map.street)
    expect(back).not.toEqual(map.spawn)
    expect(toOffice(back)).toBeGreaterThan(toOffice(map.spawn))
  })

  it('still makes a player who fell at the board walk back in', () => {
    const back = respawnPoint(map, { x: map.office.x, z: map.office.z - 5 })

    expect(isCrossing(back)).toBe(true)
    expect(toOffice(back)).toBeGreaterThanOrEqual(RESPAWN_OFFICE_CLEARANCE)
    expect(toOffice(back)).toBeGreaterThan(OFFICE_SAFE_RADIUS)
  })

  it('falls back to the map spawn when there is no crossing to pick', () => {
    // A map with no grid at all: the only thing left to come back to is its spawn point.
    const gridless: WorldMap = { ...map, size: 0 }
    expect(crossings(gridless)).toHaveLength(0)
    expect(respawnPoint(gridless, { x: 100, z: 100 })).toEqual(gridless.spawn)

    // And a fall with no position worth reading is refused rather than guessed at.
    expect(respawnPoint(map, { x: Number.NaN, z: 100 })).toEqual(map.spawn)
  })

  it('is where the world actually puts a player when the downed timer ends', () => {
    const fell = { x: 100, z: 100 }
    const room = addPlayer(quietRoom(), 'p1', GEAR, fell)
    const players = new Map(room.players)
    const player = players.get('p1')
    if (!player) throw new Error('the player is gone')
    players.set('p1', { ...player, shield: 0, downedUntil: START + 3000 })

    const after = step({ ...room, players }, map, DT, START + 3050)

    const back = respawnPoint(map, fell)
    expect(after.events).toContainEqual({ kind: 'respawn', player: 'p1', x: back.x, y: 0, z: back.z })
    expect(after.room.players.get('p1')?.x).toBe(back.x)
    expect(after.room.players.get('p1')?.z).toBe(back.z)
    expect(after.room.players.get('p1')?.shield).toBe(3)
  })
})
