import * as THREE from "three";
import type { QuestView } from "@/lib/api";
import { nim } from "@/components/play/format";
import type { Place, WorldMap } from "./map";

/**
 * Wayfinding: the one thing the player is meant to do next, where it stands in the city,
 * and how far away it is.
 *
 * The choice is made from the server's quest rows and the server's map and nothing else.
 * The top half of this file is the choosing, which React does when a quest changes. The
 * bottom half is the drawing, which runs on every frame and never touches React.
 */

export type SpotKind = "office" | "shop" | "landmark" | "pickup" | "drop";

/** A place in the city worth a beam of light, as the world server placed it. */
export type MarkerSpot = {
  id: string;
  label: string;
  kind: SpotKind;
  x: number;
  z: number;
};

export type Objective = {
  /**
   * The spots this objective could mean. More than one only on the landmarks job, where
   * the nearest one that is still unvisited is the one measured and lit.
   */
  spots: string[];
  /** What to do, in the words the objective line uses. */
  sentence: string;
  /** Sits in front of the metres. "nearest " on a hunt, empty everywhere else. */
  prefix: string;
  /** True when the distance is to the closest live drone rather than to a fixed place. */
  hunt: boolean;
  /** The job this came from, so the board can show which row is being tracked. */
  questId: string | null;
};

const LANDMARK_LABELS = ["LANDMARK 1", "LANDMARK 2", "LANDMARK 3", "LANDMARK 4"];

function questOf(quests: readonly QuestView[], kind: QuestView["kind"]): QuestView | undefined {
  return quests.find((quest) => quest.kind === kind);
}

function courierLeg(quest: QuestView | undefined): { point: number; drop: boolean } | null {
  if (!quest || quest.state !== "open" || !quest.route) return null;
  return quest.carrying === true
    ? { point: quest.route.to, drop: true }
    : { point: quest.route.from, drop: false };
}

function unvisited(quest: QuestView | undefined): number[] {
  if (!quest || quest.state !== "open") return [];
  const visited = quest.visited ?? [];
  const left: number[] = [];
  for (let index = 0; index < LANDMARK_LABELS.length; index += 1) {
    if (!visited[index]) left.push(index);
  }
  return left;
}

/** Every place that earns a beam right now: the two doors, what is left of the day's jobs. */
export function worldSpots(map: WorldMap, quests: readonly QuestView[]): MarkerSpot[] {
  const spots: MarkerSpot[] = [
    { id: "office", label: "OFFICE", kind: "office", x: map.office.x, z: map.office.z },
    { id: "shop", label: "SHOP", kind: "shop", x: map.shop.x, z: map.shop.z },
  ];

  for (const index of unvisited(questOf(quests, "landmarks"))) {
    const at = map.landmarks[index];
    if (!at) continue;
    spots.push({
      id: `landmark:${index}`,
      label: LANDMARK_LABELS[index] ?? "LANDMARK",
      kind: "landmark",
      x: at.x,
      z: at.z,
    });
  }

  const leg = courierLeg(questOf(quests, "courier"));
  if (leg) {
    const at = map.courier[leg.point];
    if (at) {
      spots.push({
        id: "courier",
        label: leg.drop ? "DROP" : "PICKUP",
        kind: leg.drop ? "drop" : "pickup",
        x: at.x,
        z: at.z,
      });
    }
  }

  return spots;
}

function claimable(quests: readonly QuestView[]): QuestView[] {
  return quests.filter((quest) => quest.state === "done");
}

function claimObjective(quests: readonly QuestView[], questId: string | null): Objective | null {
  const ready = claimable(quests);
  if (ready.length === 0) return null;
  const total = ready.reduce((sum, quest) => sum + Number(quest.rewardLuna), 0);
  return {
    spots: ["office"],
    sentence: total > 0 ? `Claim ${nim(total)} NIM at the office` : "Claim at the office",
    prefix: "",
    hunt: false,
    questId,
  };
}

function objectiveFor(quest: QuestView): Objective | null {
  if (quest.state !== "open") return null;

  if (quest.kind === "courier") {
    const leg = courierLeg(quest);
    if (!leg) return null;
    return {
      spots: ["courier"],
      sentence: leg.drop ? "Deliver the parcel" : "Pick up the parcel",
      prefix: "",
      hunt: false,
      questId: quest.id,
    };
  }

  if (quest.kind === "landmarks") {
    const left = unvisited(quest);
    if (left.length === 0) return null;
    const reached = quest.target - left.length;
    return {
      spots: left.map((index) => `landmark:${index}`),
      sentence: `Landmark ${Math.min(reached + 1, quest.target)} of ${quest.target}`,
      prefix: "",
      hunt: false,
      questId: quest.id,
    };
  }

  if (quest.kind === "hunt") {
    const left = Math.max(0, quest.target - quest.progress);
    if (left === 0) return null;
    return {
      spots: [],
      sentence: left === 1 ? "Hunt the last drone" : `Hunt drones, ${left} left`,
      prefix: "nearest ",
      hunt: true,
      questId: quest.id,
    };
  }

  return null;
}

/** True when this job is somewhere the player can walk, which is what a Track button needs. */
export function trackable(quest: QuestView): boolean {
  if (quest.state === "done") return true;
  return objectiveFor(quest) !== null;
}

export type ObjectiveInput = {
  quests: readonly QuestView[];
  /** The job the player pinned on the board, or null while the game is choosing. */
  pinned: string | null;
  /** False until this phone has opened the shop once. */
  seenShop: boolean;
};

/**
 * What the player is sent at next. The player's own pick wins; otherwise the order is the
 * one a new player needs: finish the leg you are on, then the walking jobs, then the
 * shooting, then the money, and only then the shop.
 */
export function chooseObjective({ quests, pinned, seenShop }: ObjectiveInput): Objective | null {
  if (pinned !== null) {
    const quest = quests.find((row) => row.id === pinned);
    if (quest) {
      if (quest.state === "done") return claimObjective([quest], quest.id);
      const chosen = objectiveFor(quest);
      if (chosen) return chosen;
    }
  }

  for (const kind of ["courier", "landmarks", "hunt"] as const) {
    const quest = questOf(quests, kind);
    const chosen = quest ? objectiveFor(quest) : null;
    if (chosen) return chosen;
  }

  const claim = claimObjective(quests, null);
  if (claim) return claim;

  if (!seenShop) {
    return { spots: ["shop"], sentence: "Open the shop", prefix: "", hunt: false, questId: null };
  }

  return null;
}

/** The distance a line shows: metres on the ground, the way a player paces it out. */
export function groundRange(from: Place, to: Place): number {
  return Math.hypot(to.x - from.x, to.z - from.z);
}

export function metres(range: number): string {
  return `${Math.round(range)} m`;
}

/** The nearest of the objective's spots, which is the one the beam and the compass mean. */
export function nearestSpot(
  objective: Objective | null,
  spots: readonly MarkerSpot[],
  from: Place,
): MarkerSpot | null {
  if (!objective) return null;
  let best: MarkerSpot | null = null;
  let closest = Number.POSITIVE_INFINITY;
  for (const spot of spots) {
    if (!objective.spots.includes(spot.id)) continue;
    const range = groundRange(from, spot);
    if (range >= closest) continue;
    closest = range;
    best = spot;
  }
  return best;
}

/* The drawing half: three meshes, whatever the city is asking of the player. */

const MAX_SPOTS = 8;
const MAX_RINGS = 6;

/** A beam is a tall thin sheet of light, tall enough to clear the rooftops around it. */
const BEAM_HEIGHT = 26;
const BEAM_HALF_WIDTH = 0.42;
const BEAM_FOOT = 0.2;

const LABEL_Y = 7.2;
/** Labels are gone by the time a player is standing on the spot, so they never block it. */
const LABEL_HIDDEN_M = 2.5;
const LABEL_FULL_M = 6;
const LABEL_CELL = 8;

const RING_RADIUS = 1.7;

/**
 * The answer a place gives back when it has just paid out: a ring thrown across the road
 * and a glow lifting off the player. It is drawn from the event frame, so it lands with
 * the step rather than after the database has been asked.
 */
const PULSE_MS = 640;
const PULSE_RING_FROM = 1.1;
const PULSE_RING_TO = 6.6;
/** Reduced motion keeps the answer but not the travel: one ring, held, then faded out. */
const PULSE_RING_STILL = 3.4;
const PULSE_GLOW_RISE = 1.3;
const PULSE_GLOW_HALF = 1.25;
/** The readout holds the answer a little longer than the scene draws it, so a check sees it. */
const PULSE_REPORT_MS = 2000;

/** Drones further out than this are somebody else's problem, on the strip and in the scene. */
const DRONE_SIGHT_M = 60;

/** Half the compass strip, in pixels, and the bearing that reaches its edge. */
const COMPASS_HALF_PX = 100;
const COMPASS_SPAN = Math.PI / 2;

const LABEL_ROWS = [
  "OFFICE",
  "SHOP",
  "LANDMARK 1",
  "LANDMARK 2",
  "LANDMARK 3",
  "LANDMARK 4",
  "PICKUP",
  "DROP",
];

const ATLAS_WIDTH = 512;
const ATLAS_CELL = 64;

/**
 * Vertex colours are read as light, not as paint: the renderer works in linear space and
 * writes sRGB out. Handing it the hex straight would lift the dark channels on the way
 * out and turn the accent into cream, which is what the first beam looked like.
 */
function light(hex: number): [number, number, number] {
  const colour = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return [colour.r, colour.g, colour.b];
}

const ACCENT_LIGHT = light(0xff6a2b);

const COLOURS: Record<SpotKind, [number, number, number]> = {
  office: ACCENT_LIGHT,
  shop: light(0x3ddc97),
  landmark: light(0xf3efe7),
  pickup: ACCENT_LIGHT,
  drop: ACCENT_LIGHT,
};

export type DroneSight = { x: number; y: number; z: number };

export type MarkerReadout = {
  /** How many meshes the whole wayfinding layer costs. */
  meshes: number;
  spots: { id: string; label: string; x: number; z: number; tracked: boolean }[];
  /** The spot the objective currently means, or "drone" on a hunt. */
  tracked: string | null;
  /** What the objective line is printing as its distance right now. */
  range: string;
  /** The last landmark, pickup or deliver the world answered, while the answer is live. */
  pulse: { spot: string | null; ageMs: number } | null;
};

export type Markers = {
  setSpots: (spots: MarkerSpot[]) => void;
  setObjective: (objective: Objective | null) => void;
  /** A place just paid off: light it, throw a ring across it, lift a glow off the player. */
  touch: (place: Place, spotId: string | null, now: number) => void;
  frame: (
    now: number,
    camera: THREE.PerspectiveCamera,
    at: Place,
    yaw: number,
    drones: readonly DroneSight[],
  ) => void;
  readout: () => MarkerReadout;
  dispose: () => void;
};

function quadGeometry(count: number, withUv: boolean): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 12), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 16), 4));
  if (withUv) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 8), 2));
  }
  const index = new Uint16Array(count * 6);
  for (let quad = 0; quad < count; quad += 1) {
    const base = quad * 4;
    index.set([base, base + 1, base + 2, base, base + 2, base + 3], quad * 6);
  }
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // Every quad is rebuilt around the camera each frame, so a bounding sphere worked out
  // once would cull the whole layer the moment the player walked away from the middle.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geometry;
}

/** The label sheet: one row of display type per name, drawn once and read by every quad. */
function labelAtlas(): { canvas: HTMLCanvasElement; draw: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_WIDTH;
  canvas.height = ATLAS_CELL * LABEL_ROWS.length;

  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const family =
      getComputedStyle(document.documentElement).getPropertyValue("--font-display-face").trim() ||
      "sans-serif";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.font = `900 40px ${family}, "Arial Narrow", sans-serif`;
    LABEL_ROWS.forEach((row, index) => {
      ctx.fillText(row, canvas.width / 2, index * ATLAS_CELL + ATLAS_CELL / 2, ATLAS_WIDTH - 24);
    });
  };

  draw();
  return { canvas, draw };
}

/** The outline a hunt target wears: one ring with two brackets, drawn into a texture. */
function ringTexture(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(64, 64, 40, 0.15, 1.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(64, 64, 40, Math.PI + 0.15, Math.PI + 1.4);
    ctx.stroke();
  }
  return canvas;
}

/**
 * Two cells on one sheet, so the ring on the ground and the glow on the player cost one
 * draw call between them: a hard ring on the left, a soft blob on the right.
 */
function pulseTexture(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(64, 64, 38, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const blob = ctx.createRadialGradient(192, 64, 2, 192, 64, 62);
  blob.addColorStop(0, "rgba(255,255,255,1)");
  blob.addColorStop(0.45, "rgba(255,255,255,0.35)");
  blob.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = blob;
  ctx.fillRect(128, 0, 128, 128);
  return canvas;
}

function additive(map: THREE.Texture | null): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    // A beacon that hides behind the block it stands on would be no use to anyone walking
    // towards it, so the whole layer is drawn over the city rather than inside it.
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

export type MarkersOptions = { scene: THREE.Scene; reduced: boolean };

export function createMarkers({ scene, reduced }: MarkersOptions): Markers {
  const beams = new THREE.Mesh(quadGeometry(MAX_SPOTS, false), additive(null));
  beams.frustumCulled = false;
  beams.renderOrder = 3;
  scene.add(beams);

  const atlas = labelAtlas();
  const labelMap = new THREE.CanvasTexture(atlas.canvas);
  labelMap.colorSpace = THREE.SRGBColorSpace;
  const labels = new THREE.Mesh(quadGeometry(MAX_SPOTS, true), additive(labelMap));
  labels.frustumCulled = false;
  labels.renderOrder = 4;
  scene.add(labels);

  // The display face may still be loading when the city opens, so the sheet is drawn a
  // second time once the browser says the fonts are in.
  void document.fonts?.ready.then(() => {
    atlas.draw();
    labelMap.needsUpdate = true;
  });

  const ringMap = new THREE.CanvasTexture(ringTexture());
  const rings = new THREE.Mesh(quadGeometry(MAX_RINGS, true), additive(ringMap));
  rings.frustumCulled = false;
  rings.renderOrder = 4;
  scene.add(rings);

  const pulseMap = new THREE.CanvasTexture(pulseTexture());
  const pulses = new THREE.Mesh(quadGeometry(2, true), additive(pulseMap));
  pulses.frustumCulled = false;
  pulses.renderOrder = 5;
  scene.add(pulses);

  const beamPosition = beams.geometry.getAttribute("position") as THREE.BufferAttribute;
  const beamColour = beams.geometry.getAttribute("color") as THREE.BufferAttribute;
  const labelPosition = labels.geometry.getAttribute("position") as THREE.BufferAttribute;
  const labelColour = labels.geometry.getAttribute("color") as THREE.BufferAttribute;
  const labelUv = labels.geometry.getAttribute("uv") as THREE.BufferAttribute;
  const ringPosition = rings.geometry.getAttribute("position") as THREE.BufferAttribute;
  const ringColour = rings.geometry.getAttribute("color") as THREE.BufferAttribute;
  const ringUv = rings.geometry.getAttribute("uv") as THREE.BufferAttribute;
  const pulsePosition = pulses.geometry.getAttribute("position") as THREE.BufferAttribute;
  const pulseColour = pulses.geometry.getAttribute("color") as THREE.BufferAttribute;
  const pulseUv = pulses.geometry.getAttribute("uv") as THREE.BufferAttribute;

  // Quad zero reads the ring cell, quad one the soft blob beside it.
  for (const [quad, from] of [[0, 0], [1, 0.5]] as const) {
    pulseUv.setXY(quad * 4, from, 0);
    pulseUv.setXY(quad * 4 + 1, from + 0.5, 0);
    pulseUv.setXY(quad * 4 + 2, from + 0.5, 1);
    pulseUv.setXY(quad * 4 + 3, from, 1);
  }
  pulseUv.needsUpdate = true;

  for (let quad = 0; quad < MAX_RINGS; quad += 1) {
    ringUv.setXY(quad * 4, 0, 0);
    ringUv.setXY(quad * 4 + 1, 1, 0);
    ringUv.setXY(quad * 4 + 2, 1, 1);
    ringUv.setXY(quad * 4 + 3, 0, 1);
  }
  ringUv.needsUpdate = true;

  let spots: MarkerSpot[] = [];
  let objective: Objective | null = null;
  let trackedId: string | null = null;
  let rangeText = "";
  let touchedAt = 0;
  let touchedSpot: string | null = null;
  const touchedPlace: Place = { x: 0, z: 0 };

  const root = document.documentElement;
  const written = new Map<string, string>();
  function put(name: string, value: string): void {
    if (written.get(name) === value) return;
    written.set(name, value);
    root.style.setProperty(name, value);
  }

  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const forward = new THREE.Vector3();

  /**
   * The drones in sight this frame, nearest first. The list and the readings in it are kept
   * between frames and written over, because this runs sixty times a second and a fresh
   * array of fresh objects each time is pure work for the garbage collector.
   */
  type Sighting = { x: number; y: number; z: number; range: number };
  const sightings: Sighting[] = [];
  const seen: Sighting[] = [];

  function noteSighting(x: number, y: number, z: number, range: number): void {
    let slot = sightings[seen.length];
    if (!slot) {
      slot = { x: 0, y: 0, z: 0, range: 0 };
      sightings.push(slot);
    }
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.range = range;
    seen.push(slot);
  }

  function hideQuad(
    position: THREE.BufferAttribute,
    colour: THREE.BufferAttribute,
    quad: number,
  ): void {
    for (let corner = 0; corner < 4; corner += 1) {
      position.setXYZ(quad * 4 + corner, 0, -1000, 0);
      colour.setXYZW(quad * 4 + corner, 0, 0, 0, 0);
    }
  }

  /** Where a bearing sits on the strip, and whether it ran off the end. */
  function strip(bearing: number): { x: number; edge: number } {
    const share = Math.max(-1, Math.min(1, bearing / COMPASS_SPAN));
    return {
      x: share * COMPASS_HALF_PX,
      edge: bearing > COMPASS_SPAN ? 1 : bearing < -COMPASS_SPAN ? -1 : 0,
    };
  }

  function bearingTo(at: Place, x: number, z: number, yaw: number): number {
    let off = Math.atan2(x - at.x, z - at.z) - yaw;
    while (off > Math.PI) off -= Math.PI * 2;
    while (off < -Math.PI) off += Math.PI * 2;
    return off;
  }

  function tick(name: string, on: boolean, x: number): void {
    put(`${name}-on`, on ? "1" : "0");
    if (on) put(`${name}-x`, `${x.toFixed(0)}px`);
  }

  return {
    setSpots(next) {
      spots = next.slice(0, MAX_SPOTS);
    },

    setObjective(next) {
      objective = next;
      if (!next) rangeText = "";
    },

    touch(place, spotId, now) {
      touchedAt = now;
      touchedSpot = spotId;
      touchedPlace.x = place.x;
      touchedPlace.z = place.z;
    },

    frame(now, camera, at, yaw, drones) {
      const pulse = reduced ? 1 : 0.76 + 0.24 * Math.sin(now / 260);
      // How far through its answer a touched place is: 0 as it lands, 1 once it is over.
      const answer = touchedAt === 0 ? 1 : Math.min(1, (now - touchedAt) / PULSE_MS);
      camera.matrixWorld.extractBasis(right, up, forward);
      const camX = camera.position.x;
      const camZ = camera.position.z;

      // How far off centre something can be and still be on the screen, worked out from
      // the camera itself, because a portrait phone and a laptop do not agree.
      const halfFov = Math.atan(
        Math.tan((camera.fov * Math.PI) / 360) * Math.max(0.0001, camera.aspect),
      );

      let target: { x: number; z: number; id: string } | null = null;
      if (objective && !objective.hunt) {
        const spot = nearestSpot(objective, spots, at);
        if (spot) target = { x: spot.x, z: spot.z, id: spot.id };
      }

      // The live drones, nearest first: the strip shows the closest few, the scene rings
      // them, and a hunt objective measures itself against the very nearest.
      seen.length = 0;
      for (const drone of drones) {
        const range = Math.hypot(drone.x - at.x, drone.z - at.z);
        if (range > DRONE_SIGHT_M) continue;
        noteSighting(drone.x, drone.y, drone.z, range);
      }
      seen.sort((a, b) => a.range - b.range);

      const nearestDrone = seen[0];
      if (objective?.hunt && nearestDrone) {
        target = { x: nearestDrone.x, z: nearestDrone.z, id: "drone" };
      }

      trackedId = target?.id ?? null;

      if (objective && target) {
        const range = Math.hypot(target.x - at.x, target.z - at.z);
        rangeText = `${objective.prefix}${metres(range)}`;
        put("--objective-range", `" · ${rangeText}"`);
        const bearing = bearingTo(at, target.x, target.z, yaw);
        const place = strip(bearing);
        tick("--cmp-t", true, place.x);
        put("--cmp-t-far", Math.abs(bearing) > halfFov ? "1" : "0");
        put("--cmp-t-left", place.edge < 0 ? "1" : "0");
        put("--cmp-t-right", place.edge > 0 ? "1" : "0");
        put("--cmp-t-range", `"${metres(range)}"`);
      } else {
        rangeText = "";
        put("--objective-range", '""');
        put("--cmp-t-on", "0");
        put("--cmp-t-left", "0");
        put("--cmp-t-right", "0");
      }

      for (const [name, id] of [
        ["--cmp-o", "office"],
        ["--cmp-s", "shop"],
      ] as const) {
        const spot = spots.find((row) => row.id === id);
        if (!spot) {
          put(`${name}-on`, "0");
          continue;
        }
        tick(name, true, strip(bearingTo(at, spot.x, spot.z, yaw)).x);
      }

      for (let index = 0; index < MAX_RINGS; index += 1) {
        const drone = seen[index];
        if (!drone) {
          put(`--cmp-d${index}-on`, "0");
          continue;
        }
        tick(`--cmp-d${index}`, true, strip(bearingTo(at, drone.x, drone.z, yaw)).x);
      }

      for (let quad = 0; quad < MAX_SPOTS; quad += 1) {
        const spot = spots[quad];
        if (!spot) {
          hideQuad(beamPosition, beamColour, quad);
          hideQuad(labelPosition, labelColour, quad);
          continue;
        }

        const dx = camX - spot.x;
        const dz = camZ - spot.z;
        const flat = Math.hypot(dx, dz) || 1;
        const rx = dz / flat;
        const rz = -dx / flat;
        const range = Math.hypot(spot.x - at.x, spot.z - at.z);
        const tracked = trackedId === spot.id;
        const lively = tracked || spot.kind === "pickup" || spot.kind === "drop";
        const [cr, cg, cb] = COLOURS[spot.kind];

        // Bright when it is the job in hand, a quiet marker otherwise, and faded out at
        // the door so a beam never stands between the player and what they came for.
        const near = Math.max(0, Math.min(1, (range - 1.5) / 3));
        // Additive light saturates fast: past about two thirds the accent turns white and
        // stops reading as a colour at all, so the brightest beam stops short of that.
        const base = (tracked ? 0.8 : 0.38) * (lively ? pulse : 1) * near;
        // A place that has just been touched takes the light up for as long as it answers.
        const lit = touchedSpot === spot.id && answer < 1 ? (1 - answer) * 0.55 : 0;
        const strength = Math.min(0.95, base + lit);

        const x0 = spot.x - rx * BEAM_HALF_WIDTH;
        const z0 = spot.z - rz * BEAM_HALF_WIDTH;
        const x1 = spot.x + rx * BEAM_HALF_WIDTH;
        const z1 = spot.z + rz * BEAM_HALF_WIDTH;
        beamPosition.setXYZ(quad * 4, x0, BEAM_FOOT, z0);
        beamPosition.setXYZ(quad * 4 + 1, x1, BEAM_FOOT, z1);
        beamPosition.setXYZ(quad * 4 + 2, x1, BEAM_FOOT + BEAM_HEIGHT, z1);
        beamPosition.setXYZ(quad * 4 + 3, x0, BEAM_FOOT + BEAM_HEIGHT, z0);
        beamColour.setXYZW(quad * 4, cr, cg, cb, strength);
        beamColour.setXYZW(quad * 4 + 1, cr, cg, cb, strength);
        beamColour.setXYZW(quad * 4 + 2, cr, cg, cb, 0);
        beamColour.setXYZW(quad * 4 + 3, cr, cg, cb, 0);

        const row = LABEL_ROWS.indexOf(spot.label);
        const close = (range - LABEL_HIDDEN_M) / (LABEL_FULL_M - LABEL_HIDDEN_M);
        const fade = Math.max(0, Math.min(1, close));
        const far = Math.max(0, Math.min(1, 1 - (range - 90) / 40));
        const height = Math.max(1, Math.min(3, range * 0.045));
        const half = (height * LABEL_CELL) / 2;
        const alpha = fade * far * (tracked ? 1 : 0.62);

        const lx0 = spot.x - rx * half;
        const lz0 = spot.z - rz * half;
        const lx1 = spot.x + rx * half;
        const lz1 = spot.z + rz * half;
        labelPosition.setXYZ(quad * 4, lx0, LABEL_Y, lz0);
        labelPosition.setXYZ(quad * 4 + 1, lx1, LABEL_Y, lz1);
        labelPosition.setXYZ(quad * 4 + 2, lx1, LABEL_Y + height, lz1);
        labelPosition.setXYZ(quad * 4 + 3, lx0, LABEL_Y + height, lz0);
        labelColour.setXYZW(quad * 4, cr, cg, cb, alpha);
        labelColour.setXYZW(quad * 4 + 1, cr, cg, cb, alpha);
        labelColour.setXYZW(quad * 4 + 2, cr, cg, cb, alpha);
        labelColour.setXYZW(quad * 4 + 3, cr, cg, cb, alpha);

        const top = 1 - Math.max(0, row) / LABEL_ROWS.length;
        const bottom = top - 1 / LABEL_ROWS.length;
        labelUv.setXY(quad * 4, 0, bottom);
        labelUv.setXY(quad * 4 + 1, 1, bottom);
        labelUv.setXY(quad * 4 + 2, 1, top);
        labelUv.setXY(quad * 4 + 3, 0, top);
      }

      const hunting = objective?.hunt === true;
      for (let quad = 0; quad < MAX_RINGS; quad += 1) {
        const drone = seen[quad];
        if (!drone || !hunting) {
          hideQuad(ringPosition, ringColour, quad);
          continue;
        }
        const alpha = quad === 0 ? 0.95 * pulse : 0.2;
        for (let corner = 0; corner < 4; corner += 1) {
          const sx = corner === 1 || corner === 2 ? 1 : -1;
          const sy = corner >= 2 ? 1 : -1;
          ringPosition.setXYZ(
            quad * 4 + corner,
            drone.x + right.x * RING_RADIUS * sx + up.x * RING_RADIUS * sy,
            drone.y + right.y * RING_RADIUS * sx + up.y * RING_RADIUS * sy,
            drone.z + right.z * RING_RADIUS * sx + up.z * RING_RADIUS * sy,
          );
          ringColour.setXYZW(
            quad * 4 + corner,
            ACCENT_LIGHT[0],
            ACCENT_LIGHT[1],
            ACCENT_LIGHT[2],
            alpha,
          );
        }
      }

      if (answer < 1) {
        const fade = 1 - answer;
        const radius = reduced
          ? PULSE_RING_STILL
          : PULSE_RING_FROM + (PULSE_RING_TO - PULSE_RING_FROM) * (1 - fade * fade);
        const ringAlpha = fade * 0.95;
        const corners: [number, number][] = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ];
        corners.forEach(([sx, sz], corner) => {
          pulsePosition.setXYZ(
            corner,
            touchedPlace.x + sx * radius,
            0.08,
            touchedPlace.z + sz * radius,
          );
          pulseColour.setXYZW(corner, ACCENT_LIGHT[0], ACCENT_LIGHT[1], ACCENT_LIGHT[2], ringAlpha);
        });

        // The glow belongs to the player, not to the place, so it follows them while it lasts.
        const lift = 1 + (reduced ? 0.4 : PULSE_GLOW_RISE * answer);
        const glowAlpha = fade * (reduced ? 0.6 : 0.8);
        corners.forEach(([sx, sy], corner) => {
          const quad = 4 + corner;
          pulsePosition.setXYZ(
            quad,
            at.x + right.x * PULSE_GLOW_HALF * sx + up.x * PULSE_GLOW_HALF * sy,
            lift + right.y * PULSE_GLOW_HALF * sx + up.y * PULSE_GLOW_HALF * sy,
            at.z + right.z * PULSE_GLOW_HALF * sx + up.z * PULSE_GLOW_HALF * sy,
          );
          pulseColour.setXYZW(quad, ACCENT_LIGHT[0], ACCENT_LIGHT[1], ACCENT_LIGHT[2], glowAlpha);
        });
      } else {
        hideQuad(pulsePosition, pulseColour, 0);
        hideQuad(pulsePosition, pulseColour, 1);
      }

      pulsePosition.needsUpdate = true;
      pulseColour.needsUpdate = true;
      beamPosition.needsUpdate = true;
      beamColour.needsUpdate = true;
      labelPosition.needsUpdate = true;
      labelColour.needsUpdate = true;
      labelUv.needsUpdate = true;
      ringPosition.needsUpdate = true;
      ringColour.needsUpdate = true;
    },

    readout: () => ({
      meshes: 4,
      spots: spots.map((spot) => ({
        id: spot.id,
        label: spot.label,
        x: spot.x,
        z: spot.z,
        tracked: trackedId === spot.id,
      })),
      tracked: trackedId,
      range: rangeText,
      pulse: (() => {
        if (touchedAt === 0) return null;
        const ageMs = Math.round(performance.now() - touchedAt);
        return ageMs > PULSE_REPORT_MS ? null : { spot: touchedSpot, ageMs };
      })(),
    }),

    dispose() {
      for (const mesh of [beams, labels, rings, pulses]) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      labelMap.dispose();
      ringMap.dispose();
      pulseMap.dispose();
      for (const name of written.keys()) root.style.removeProperty(name);
      written.clear();
    },
  };
}
