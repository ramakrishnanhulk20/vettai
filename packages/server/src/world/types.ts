/**
 * The shapes the world server, the tests and the client all agree on. Metres, seconds and
 * radians; y is up; the map spans x and z in [-144, 144]. Time is always whole
 * milliseconds from the caller's clock, passed in as `now`, never read here.
 */

export type Place = { x: number; z: number }

export type Vec3 = { x: number; y: number; z: number }

/** An axis aligned footprint. Buildings are boxes from the ground up, so y never appears. */
export type Box = { minX: number; minZ: number; maxX: number; maxZ: number }

/** A lot coordinate on the 12 by 12 grid, column first. */
export type Lot = [i: number, j: number]

export type Building = {
  readonly lot: Lot
  readonly type: number
  readonly height: number
  readonly aabb: Box
}

/** Drone waypoints, in order, walked as a loop. They are flown at PATROL_Y, see map.ts. */
export type PatrolLoop = Place[]

export type WorldMap = {
  readonly version: string
  readonly size: number
  readonly lotSize: number
  readonly street: number
  readonly buildings: Building[]
  readonly parks: Lot[]
  readonly office: Place
  readonly shop: Place
  readonly landmarks: [Place, Place, Place, Place]
  readonly courier: [Place, Place, Place, Place, Place, Place, Place, Place]
  readonly patrols: PatrolLoop[]
  readonly spawn: Place
}

/**
 * What a player owns. `blaster` and `skin` mirror the players.gear column in the database;
 * `sprint` is the shop item that raises the speed cap, and a row saved before that item
 * existed simply has no flag.
 */
export type PlayerGear = { blaster: 'mk1' | 'mk2'; skin: string; sprint?: boolean }

/** `dx` and `dz` are a world space unit vector or zero. `yaw` is where the player looks. */
export type MoveIntent = { dx: number; dz: number; yaw: number }

/** Yaw 0 looks along +z, pitch is positive upward. */
export type FireIntent = { yaw: number; pitch: number }

export type PlayerState = {
  readonly id: string
  readonly x: number
  readonly z: number
  readonly yaw: number
  readonly vx: number
  readonly vz: number
  readonly shield: number
  /** Milliseconds at which a downed player comes back. 0 means up. */
  readonly downedUntil: number
  readonly lastFireAt: number
  /** Fire times inside the last second, oldest first. The rate cap is a sliding window. */
  readonly recentFires: readonly number[]
  /** When the next shield bar is handed back. Pushed forward by every hit taken. */
  readonly nextShieldAt: number
  readonly lastIntentAt: number
  readonly intent: MoveIntent
  readonly gear: PlayerGear
}

export type DroneState = {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  readonly hp: number
  readonly state: 'patrol' | 'engage' | 'dead'
  readonly loop: number
  readonly waypoint: number
  readonly target: string | null
  readonly nextFireAt: number
  /** A wreck is kept for a moment so the client can play the explosion, then removed. */
  readonly deadUntil: number
  /** Damage taken per player id. The top of this map gets the kill. */
  readonly damage: ReadonlyMap<string, number>
}

export type BoltState = {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly vx: number
  readonly vy: number
  readonly vz: number
  readonly ownerDrone: string
  readonly bornAt: number
}

export type RoomState = {
  readonly tick: number
  readonly players: Map<string, PlayerState>
  readonly drones: Map<string, DroneState>
  readonly bolts: BoltState[]
  readonly nextDroneSpawnAt: number
  readonly ids: { readonly drone: number; readonly bolt: number }
  /** Kept so every spawn choice is drawn from the seed and the id counter, never a clock. */
  readonly seed: string
}

export type SimEvent =
  | { kind: 'hit'; player: string; drone: string; damage: number; x: number; y: number; z: number }
  | { kind: 'kill'; player: string; drone: string; x: number; y: number; z: number }
  | { kind: 'droneHit'; player: string; drone: string; damage: number; x: number; y: number; z: number }
  | { kind: 'downed'; player: string; x: number; y: number; z: number }
  | { kind: 'respawn'; player: string; x: number; y: number; z: number }
  | { kind: 'spawn'; drone: string; x: number; y: number; z: number }
