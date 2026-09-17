/**
 * The city as the world server hands it over at GET /api/world/map. These types mirror
 * packages/server/src/world/types.ts field for field: metres, y is up, and the map spans
 * x and z in [-size/2, size/2]. Nothing about the block is decided on this side.
 */

export type Place = { x: number; z: number };

export type Box = { minX: number; minZ: number; maxX: number; maxZ: number };

export type Lot = [i: number, j: number];

export type Building = {
  lot: Lot;
  type: number;
  height: number;
  aabb: Box;
};

export type PatrolLoop = Place[];

export type WorldMap = {
  version: string;
  size: number;
  lotSize: number;
  street: number;
  buildings: Building[];
  parks: Lot[];
  office: Place;
  shop: Place;
  landmarks: [Place, Place, Place, Place];
  courier: Place[];
  patrols: PatrolLoop[];
  spawn: Place;
};

/** Drones fly their loops at this height, matching PATROL_Y on the server. */
export const PATROL_Y = 6;

/**
 * The numbers the world server and this client have to agree on. Only the ones the scene
 * draws with are listed: the rest of the endpoint is the simulation's business.
 */
export type WorldConstants = {
  officeSafeRadius: number;
  interactRange: number;
  patrolY: number;
  hitscanRange: number;
  aimConeDegrees: number;
};

export async function fetchWorldConstants(signal?: AbortSignal): Promise<WorldConstants> {
  const response = await fetch("/api/world/constants", { signal });
  if (!response.ok) throw new Error(`the world server answered ${response.status}`);
  return (await response.json()) as WorldConstants;
}

export async function fetchWorldMap(signal?: AbortSignal): Promise<WorldMap> {
  const response = await fetch("/api/world/map", { signal });
  if (!response.ok) throw new Error(`the world server answered ${response.status}`);
  return (await response.json()) as WorldMap;
}
