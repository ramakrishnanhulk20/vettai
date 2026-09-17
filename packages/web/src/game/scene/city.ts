import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BuildingAsset, CityAssets } from "./assets";
import type { WorldMap } from "../map";
import { glowTexture, type Look, noiseTexture, PALETTE } from "./materials";

/**
 * The block, drawn from the map the server generated. One InstancedMesh per building type
 * keeps the whole city inside about two dozen draw calls, which is the budget the live
 * game has to share on a phone.
 *
 * The second look is additive: every branch below is guarded by `look`, so the first look
 * draws exactly what it drew before the second one was written.
 */

const LOT_FILL = 0.84;
const WINDOW_LIMIT = 2400;
const FLOOR_HEIGHT = 3.4;
const WINDOW_CHANCE = 0.34;
const STREET_TILE_PX = 512;

const ASPHALT = "#1b212d";
const PAVEMENT = "#232a38";
const KERB = "#2c3446";
const LANE = "rgba(206,214,232,0.45)";
const LAMP = "rgba(255,168,92,0.34)";

const PARK_COLOR = 0x14271c;
const WINDOW_COLOR = 0xffb35c;

/** The wet street: darker tarmac, brighter paint, a kerb that catches the lamps. */
const ASPHALT_V2 = "#0f141d";
const PAVEMENT_V2 = "#1d2432";
const KERB_V2 = "#39445a";
const LANE_V2 = "rgba(226,232,246,0.62)";

/** How far a lamp's pool of light reaches across the road, in metres. */
const POOL_RADIUS = 5.2;

/** One window in twenty is on a bad ballast and flickers. */
const FLICKER_SHARE = 0.05;

/** Same seeded generator on every load, so the lit windows never move between visits. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One cell of the grid painted once and repeated across the ground: the 8 m street strip
 * with its dashed centre lines, the pavement around the lot, and two pools of sodium
 * light. Repeating a cell instead of painting the whole map keeps the road sharp at the
 * 4 m camera height, where a single map-wide texture would be a smear.
 */
function streetTexture(map: WorldMap): THREE.CanvasTexture {
  const cell = map.lotSize + map.street;
  const px = STREET_TILE_PX / cell;
  const canvas = document.createElement("canvas");
  canvas.width = STREET_TILE_PX;
  canvas.height = STREET_TILE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser gave no 2d canvas for the street");

  ctx.fillStyle = ASPHALT;
  ctx.fillRect(0, 0, STREET_TILE_PX, STREET_TILE_PX);

  const lotStart = map.street * px;
  const lotSize = map.lotSize * px;
  ctx.fillStyle = KERB;
  ctx.fillRect(lotStart - 1.1 * px, lotStart - 1.1 * px, lotSize + 2.2 * px, lotSize + 2.2 * px);
  ctx.fillStyle = PAVEMENT;
  ctx.fillRect(lotStart, lotStart, lotSize, lotSize);

  ctx.strokeStyle = LANE;
  ctx.lineWidth = 0.18 * px;
  ctx.setLineDash([2.2 * px, 2.4 * px]);
  const centre = (map.street / 2) * px;
  ctx.beginPath();
  ctx.moveTo(centre, map.street * px);
  ctx.lineTo(centre, STREET_TILE_PX);
  ctx.moveTo(map.street * px, centre);
  ctx.lineTo(STREET_TILE_PX, centre);
  ctx.stroke();
  ctx.setLineDash([]);

  const pools: [number, number][] = [
    [centre, lotStart + lotSize * 0.25],
    [lotStart + lotSize * 0.7, centre],
  ];
  for (const [x, y] of pools) {
    const pool = ctx.createRadialGradient(x, y, 0, x, y, 4.4 * px);
    pool.addColorStop(0, LAMP);
    pool.addColorStop(1, "rgba(255,168,92,0)");
    ctx.fillStyle = pool;
    ctx.fillRect(x - 4.4 * px, y - 4.4 * px, 8.8 * px, 8.8 * px);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const cells = map.size / cell;
  texture.repeat.set(cells, cells);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * The same cell, repainted for the second look: darker tarmac with blotches of old
 * repair, a kerb line bright enough to catch a lamp, a zebra across the mouth of the
 * junction, and no baked light pools. The pools are real geometry now, so they land
 * under the lamp that is actually standing there.
 */
function streetTextureV2(map: WorldMap): THREE.CanvasTexture {
  const cell = map.lotSize + map.street;
  const px = STREET_TILE_PX / cell;
  const canvas = document.createElement("canvas");
  canvas.width = STREET_TILE_PX;
  canvas.height = STREET_TILE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser gave no 2d canvas for the street");

  ctx.fillStyle = ASPHALT_V2;
  ctx.fillRect(0, 0, STREET_TILE_PX, STREET_TILE_PX);

  // Patches of newer and older tarmac. Without them the road is one flat value and the
  // camera slides over it as if it were a backdrop.
  const patches = mulberry32(0x4d21);
  for (let patch = 0; patch < 90; patch += 1) {
    const size = (6 + patches() * 42) * (px / 8);
    const shade = patches() > 0.5 ? "rgba(255,255,255,0.022)" : "rgba(0,0,0,0.05)";
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(
      patches() * STREET_TILE_PX,
      patches() * STREET_TILE_PX,
      size,
      size * (0.4 + patches() * 0.8),
      patches() * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  const lotStart = map.street * px;
  const lotSize = map.lotSize * px;
  ctx.fillStyle = KERB_V2;
  ctx.fillRect(lotStart - 1.1 * px, lotStart - 1.1 * px, lotSize + 2.2 * px, lotSize + 2.2 * px);
  ctx.fillStyle = PAVEMENT_V2;
  ctx.fillRect(lotStart, lotStart, lotSize, lotSize);

  // Paving slabs, drawn as hairlines rather than tiles: at four metres up the eye reads
  // the rhythm, not the stone.
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = Math.max(1, 0.05 * px);
  for (let slab = 1; slab * 2 * px < map.lotSize * px; slab += 1) {
    const at = lotStart + slab * 2 * px;
    ctx.beginPath();
    ctx.moveTo(at, lotStart);
    ctx.lineTo(at, lotStart + lotSize);
    ctx.moveTo(lotStart, at);
    ctx.lineTo(lotStart + lotSize, at);
    ctx.stroke();
  }

  const centre = (map.street / 2) * px;
  ctx.strokeStyle = LANE_V2;
  ctx.lineWidth = 0.18 * px;
  ctx.setLineDash([2.2 * px, 2.4 * px]);
  ctx.beginPath();
  ctx.moveTo(centre, map.street * px);
  ctx.lineTo(centre, STREET_TILE_PX);
  ctx.moveTo(map.street * px, centre);
  ctx.lineTo(STREET_TILE_PX, centre);
  ctx.stroke();
  ctx.setLineDash([]);

  // The crossing at the junction, worn down the middle where the tyres run.
  ctx.fillStyle = "rgba(226,232,246,0.34)";
  for (let bar = 0; bar < 5; bar += 1) {
    ctx.fillRect(lotStart + (bar * 1.5 + 0.4) * px, 0.9 * px, 0.7 * px, 2.1 * px);
    ctx.fillRect(0.9 * px, lotStart + (bar * 1.5 + 0.4) * px, 2.1 * px, 0.7 * px);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const cells = map.size / cell;
  texture.repeat.set(cells, cells);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * How wet each patch of road is. Rain has run to the gutters and dried on the crown, so
 * the noise is stretched along the streets rather than sprinkled evenly.
 */
function wetness(map: WorldMap): THREE.Texture {
  const texture = noiseTexture(0x2c8f, 128, 0.55);
  const cells = map.size / (map.lotSize + map.street);
  texture.repeat.set(cells * 0.5, cells * 2);
  return texture;
}

/**
 * The pool of light under every lamp, as one instanced disc. A point light per lamp is
 * hundreds of lights the phone cannot pay for; this is the part of that light the player
 * actually looks at.
 */
function lampPools(map: WorldMap): THREE.InstancedMesh {
  const spots = lampSpots(map);
  const count = spots.length / 2;

  const disc = new THREE.CircleGeometry(POOL_RADIUS, 20);
  disc.rotateX(-Math.PI / 2);

  const pools = new THREE.InstancedMesh(
    disc,
    new THREE.MeshBasicMaterial({
      map: glowTexture([
        { at: 0, colour: "rgba(255,196,138,0.85)" },
        { at: 0.35, colour: "rgba(255,150,80,0.34)" },
        { at: 1, colour: "rgba(255,120,40,0)" },
      ]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
    count,
  );
  pools.name = "lampPools";
  pools.renderOrder = 1;

  const dummy = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    dummy.position.set(spots[index * 2] as number, 0.035, spots[index * 2 + 1] as number);
    dummy.updateMatrix();
    pools.setMatrixAt(index, dummy.matrix);
  }
  pools.instanceMatrix.needsUpdate = true;
  pools.computeBoundingSphere();
  return pools;
}

function flatPlane(size: number): THREE.PlaneGeometry {
  const plane = new THREE.PlaneGeometry(size, size);
  plane.rotateX(-Math.PI / 2);
  return plane;
}

type Placed = {
  asset: BuildingAsset;
  matrix: THREE.Matrix4;
  centre: THREE.Vector3;
  yaw: number;
  width: number;
  depth: number;
  height: number;
};

function place(map: WorldMap, assets: CityAssets): Placed[] {
  const dummy = new THREE.Object3D();
  const placed: Placed[] = [];

  map.buildings.forEach((building, index) => {
    const asset = assets.buildings[building.type];
    if (!asset) return;

    const box = asset.geometry.boundingBox;
    if (!box) return;

    const rng = mulberry32(building.lot[0] * 7919 + building.lot[1] * 104729 + index);
    const quarter = Math.floor(rng() * 4);
    const yaw = (quarter * Math.PI) / 2;

    const spread = (map.lotSize * LOT_FILL) / asset.footprint;
    const lift = building.height / asset.height;
    const x = (building.aabb.minX + building.aabb.maxX) / 2;
    const z = (building.aabb.minZ + building.aabb.maxZ) / 2;

    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(spread, lift, spread);
    dummy.updateMatrix();

    placed.push({
      asset,
      matrix: dummy.matrix.clone(),
      centre: new THREE.Vector3(x, 0, z),
      yaw,
      width: (box.max.x - box.min.x) * spread,
      depth: (box.max.z - box.min.z) * spread,
      height: building.height,
    });
  });

  return placed;
}

/**
 * How wide a merged block of buildings is, in lots. Twenty building types meant twenty
 * instanced meshes, and because each type's instances were scattered across the whole map
 * every one of them was inside the frame from anywhere in the city: twenty draw calls that
 * frustum culling could never take away. Every model shares one texture, so the type's own
 * tint goes into the vertices instead and the block merges into a single mesh that stands
 * in one place and drops out of the frame like anything else.
 */
const TILE_LOTS = 3;

/** The attributes a merged facade carries. Anything else a model ships with is dropped. */
const FACADE_ATTRIBUTES = ["position", "normal", "uv", "color"] as const;

/**
 * One building, ready to weld: standing where it stands, with its type's colour written
 * into its vertices so that every block in the city can share one material.
 */
function facadeGeometry(item: Placed): THREE.BufferGeometry {
  const source = item.asset.geometry;
  const geometry = new THREE.BufferGeometry();
  const count = source.getAttribute("position").count;

  for (const name of FACADE_ATTRIBUTES) {
    const attribute = source.getAttribute(name);
    if (attribute) geometry.setAttribute(name, attribute.clone());
  }
  if (source.index) geometry.setIndex(source.index.clone());

  // The second look already shades the wall from the pavement up; the first look has no
  // colours at all. Either way the type's tint is multiplied in here and the shared
  // material is left white, which is exactly what the per type material was doing.
  const tint = item.asset.material.color;
  const existing = geometry.getAttribute("color");
  const shades = new Float32Array(count * 3);
  for (let point = 0; point < count; point += 1) {
    const r = existing ? existing.getX(point) : 1;
    const g = existing ? existing.getY(point) : 1;
    const b = existing ? existing.getZ(point) : 1;
    shades[point * 3] = r * tint.r;
    shades[point * 3 + 1] = g * tint.g;
    shades[point * 3 + 2] = b * tint.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(shades, 3));

  geometry.applyMatrix4(item.matrix);
  return geometry;
}

/** The whole block, as one mesh per tile of the map rather than one per building type. */
function facades(map: WorldMap, placed: Placed[]): THREE.Mesh[] {
  const first = placed[0];
  if (!first) return [];

  const span = (map.lotSize + map.street) * TILE_LOTS;
  const tiles = new Map<string, THREE.BufferGeometry[]>();
  for (const item of placed) {
    const column = Math.floor((item.centre.x + map.size / 2) / span);
    const row = Math.floor((item.centre.z + map.size / 2) / span);
    const key = `${column}:${row}`;
    const list = tiles.get(key);
    const geometry = facadeGeometry(item);
    if (list) list.push(geometry);
    else tiles.set(key, [geometry]);
  }

  // Every model points at the same colormap and none of them offsets it, so one material
  // carries the lot. The tint that used to live on it now lives in the vertices.
  const shared = first.asset.material.clone();
  shared.color.setHex(0xffffff);
  shared.vertexColors = true;

  const meshes: THREE.Mesh[] = [];
  for (const [key, parts] of tiles) {
    const indexed = parts.every((part) => part.index !== null);
    const ready = indexed ? parts : parts.map((part) => part.toNonIndexed());
    const welded = mergeGeometries(ready, false);
    if (!welded) continue;
    for (const part of parts) part.dispose();
    if (!indexed) for (const part of ready) part.dispose();

    welded.computeBoundingSphere();
    const mesh = new THREE.Mesh(welded, shared);
    mesh.name = `facades ${key}`;
    meshes.push(mesh);
  }
  return meshes;
}

const FACES: { rotation: number; axis: "x" | "z"; sign: number }[] = [
  { rotation: 0, axis: "z", sign: 1 },
  { rotation: Math.PI, axis: "z", sign: -1 },
  { rotation: Math.PI / 2, axis: "x", sign: 1 },
  { rotation: -Math.PI / 2, axis: "x", sign: -1 },
];

/**
 * Lit windows, as two InstancedMeshes: a sharp amber quad and a wider faint one over it.
 * That second pass is the glow, which is why this scene needs no postprocessing.
 */
function windows(placed: Placed[], look: Look): THREE.Group {
  const dummy = new THREE.Object3D();
  const offset = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const matrices: THREE.Matrix4[] = [];

  for (const item of placed) {
    if (matrices.length >= WINDOW_LIMIT) break;

    const rng = mulberry32(Math.round(item.centre.x * 31 + item.centre.z * 17 + item.height));
    const floors = Math.min(12, Math.max(1, Math.floor(item.height / FLOOR_HEIGHT)));

    for (const face of FACES) {
      const faceWidth = face.axis === "z" ? item.width : item.depth;
      const reach = face.axis === "z" ? item.depth : item.width;
      const columns = Math.max(2, Math.round(faceWidth / 2.6));

      for (let floor = 0; floor < floors; floor++) {
        for (let column = 0; column < columns; column++) {
          if (rng() > WINDOW_CHANCE) continue;
          if (matrices.length >= WINDOW_LIMIT) break;

          const along = ((column + 0.5) / columns - 0.5) * faceWidth * 0.82;
          const y = (floor + 0.62) * FLOOR_HEIGHT;
          const out = reach / 2 + 0.06;

          if (face.axis === "z") offset.set(along * face.sign, y, out * face.sign);
          else offset.set(out * face.sign, y, -along * face.sign);
          offset.applyAxisAngle(up, item.yaw);

          dummy.position.copy(item.centre).add(offset);
          dummy.rotation.set(0, item.yaw + face.rotation, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          matrices.push(dummy.matrix.clone());
        }
      }
    }
  }

  const pane = new THREE.PlaneGeometry(0.75, 1.05);
  const group = new THREE.Group();
  group.name = "windows";

  const lit = new THREE.InstancedMesh(
    pane,
    new THREE.MeshBasicMaterial({ color: WINDOW_COLOR, toneMapped: false }),
    matrices.length,
  );
  // Plain blending rather than additive: two or three haloes overlapping on a facade the
  // player is standing against used to add up to white, which blew the whole wall out.
  // Capped at its own opacity the glow still reads from across the block.
  const glow = new THREE.InstancedMesh(
    pane,
    look === "v2"
      ? new THREE.MeshBasicMaterial({
          color: WINDOW_COLOR,
          map: glowTexture([
            { at: 0, colour: "rgba(255,255,255,0.9)" },
            { at: 0.35, colour: "rgba(255,255,255,0.32)" },
            { at: 1, colour: "rgba(255,255,255,0)" },
          ]),
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          toneMapped: false,
          blending: THREE.AdditiveBlending,
        })
      : new THREE.MeshBasicMaterial({
          color: WINDOW_COLOR,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
          toneMapped: false,
        }),
    matrices.length,
  );

  const wide = new THREE.Matrix4();
  const halo =
    look === "v2"
      ? new THREE.Matrix4().makeScale(3.4, 2.8, 1)
      : new THREE.Matrix4().makeScale(2.3, 1.9, 1);
  matrices.forEach((matrix, index) => {
    lit.setMatrixAt(index, matrix);
    wide.copy(matrix).multiply(halo);
    glow.setMatrixAt(index, wide);
  });
  lit.instanceMatrix.needsUpdate = true;
  glow.instanceMatrix.needsUpdate = true;
  lit.frustumCulled = false;
  glow.frustumCulled = false;
  glow.renderOrder = 2;

  group.add(lit, glow);
  if (look === "v2") tintWindows(group, lit, glow, matrices.length);
  return group;
}

/**
 * The second look's windows: three warm tints, a few cold offices somebody left a strip
 * light on in, and one in twenty on a failing ballast. Per instance colour keeps all of
 * it inside the same two draw calls, and the flicker only touches the card when a
 * window actually changes state.
 */
function tintWindows(
  group: THREE.Group,
  lit: THREE.InstancedMesh,
  glow: THREE.InstancedMesh,
  count: number,
): void {
  (lit.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
  (glow.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);

  const rng = mulberry32(0x8817);
  const shade = new THREE.Color();
  const flicker: number[] = [];
  const phase: number[] = [];
  const rate: number[] = [];
  const bright: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const cold = rng() > 0.92;
    const warm = PALETTE.windowWarm[Math.min(2, Math.floor(rng() * 3))] ?? WINDOW_COLOR;
    const hex = cold ? PALETTE.windowCold : warm;
    shade.setHex(hex);
    lit.setColorAt(index, shade);
    glow.setColorAt(index, shade);

    if (rng() < FLICKER_SHARE) {
      flicker.push(index);
      phase.push(rng() * 12);
      rate.push(1.6 + rng() * 5.5);
      bright.push(hex);
    }
  }
  if (lit.instanceColor) lit.instanceColor.needsUpdate = true;
  if (glow.instanceColor) glow.instanceColor.needsUpdate = true;

  const state = new Uint8Array(flicker.length).fill(1);
  const dim = new THREE.Color();

  group.userData.tick = (elapsed: number) => {
    let changed = false;
    for (let slot = 0; slot < flicker.length; slot += 1) {
      const wave = Math.sin(elapsed * (rate[slot] as number) + (phase[slot] as number));
      const on = wave > -0.55 ? 1 : 0;
      if (on === state[slot]) continue;
      state[slot] = on;
      changed = true;
      const index = flicker[slot] as number;
      const hex = bright[slot] as number;
      shade.setHex(hex);
      dim.setHex(hex).multiplyScalar(0.16);
      lit.setColorAt(index, on === 1 ? shade : dim);
      glow.setColorAt(index, on === 1 ? shade : dim);
    }
    if (!changed) return;
    if (lit.instanceColor) lit.instanceColor.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  };
}

/** Lamps stand this far apart along a street, and this high. */
const LAMP_SPACING = 24;
const LAMP_TOP = 4.1;

/**
 * Vertex colours are read as linear, so the two shades are converted once from the sRGB
 * values they were picked as. Skipping that is what turns a warm sodium head into a pale
 * grey ball.
 */
function linear(hex: number): [number, number, number] {
  const colour = new THREE.Color(hex).convertSRGBToLinear();
  return [colour.r, colour.g, colour.b];
}

const POLE_COLOR = linear(0x2a3040);
const HEAD_COLOR = linear(0xffb070);

/**
 * Where every street lamp stands, as x and z pair by pair: down the middle of each street
 * running north and each street running east. The same list lights the two lamps nearest
 * the player, so it is worked out once and shared.
 */
export function lampSpots(map: WorldMap): Float32Array {
  const cell = map.lotSize + map.street;
  const half = map.size / 2;
  const lines = Math.round(map.size / cell);
  const along = Math.max(1, Math.round(map.size / LAMP_SPACING));

  // The lamps stand at the kerb rather than on the centre line, alternating sides down
  // the street: a pole in the middle of the road is the first thing a player walks into.
  const kerb = map.street / 2 - 0.7;

  const spots: number[] = [];
  for (let line = 0; line < lines; line += 1) {
    const centre = -half + line * cell + map.street / 2;
    for (let step = 0; step < along; step += 1) {
      const run = -half + (step + 0.5) * LAMP_SPACING;
      const side = step % 2 === 0 ? kerb : -kerb;
      spots.push(centre + side, run);
      spots.push(run, centre + side);
    }
  }
  return new Float32Array(spots);
}

/**
 * One lamp: a dark pole with a warm head, welded into a single geometry and coloured per
 * vertex. Two meshes would be two draw calls for the whole city, and the colour is what
 * lets one unlit material carry both the pole and the glow.
 */
function lampGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.07, 0.1, LAMP_TOP, 5, 1, true)
    .translate(0, LAMP_TOP / 2, 0)
    .toNonIndexed();
  const head = new THREE.SphereGeometry(0.2, 6, 4).translate(0, LAMP_TOP, 0).toNonIndexed();

  const polePoints = pole.getAttribute("position").array as Float32Array;
  const headPoints = head.getAttribute("position").array as Float32Array;

  const positions = new Float32Array(polePoints.length + headPoints.length);
  positions.set(polePoints, 0);
  positions.set(headPoints, polePoints.length);

  const colors = new Float32Array(positions.length);
  for (let at = 0; at < positions.length; at += 3) {
    const shade = at < polePoints.length ? POLE_COLOR : HEAD_COLOR;
    colors[at] = shade[0];
    colors[at + 1] = shade[1];
    colors[at + 2] = shade[2];
  }

  pole.dispose();
  head.dispose();

  const lamp = new THREE.BufferGeometry();
  lamp.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  lamp.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return lamp;
}

function streetLamps(map: WorldMap): THREE.InstancedMesh {
  const spots = lampSpots(map);
  const count = spots.length / 2;
  const lamps = new THREE.InstancedMesh(
    lampGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true }),
    count,
  );
  lamps.name = "lamps";

  const dummy = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    dummy.position.set(spots[index * 2] as number, 0, spots[index * 2 + 1] as number);
    dummy.updateMatrix();
    lamps.setMatrixAt(index, dummy.matrix);
  }
  lamps.instanceMatrix.needsUpdate = true;
  lamps.computeBoundingSphere();
  return lamps;
}

/** The accent, the one colour the whole game marks its own things with. */
const SAFE_RING_COLOUR = 0xff6a2b;
const SAFE_RING_WIDTH = 0.22;

/**
 * The no-fire circle around the office, drawn on the road as a thin accent line. The rule
 * is the server's: no shot is accepted from inside it and no bolt crosses it, and until
 * this ring existed the only way to learn that was to pull the trigger and watch nothing
 * happen. One draw call, and it culls with the corner of the block the office stands on.
 *
 * @param radius metres, as the world server reports them. Nothing here assumes a number.
 */
export function safeCircle(at: { x: number; z: number }, radius: number): THREE.Mesh {
  const ring = new THREE.RingGeometry(radius - SAFE_RING_WIDTH, radius + SAFE_RING_WIDTH, 96);
  ring.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(
    ring,
    new THREE.MeshBasicMaterial({
      color: SAFE_RING_COLOUR,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  mesh.name = "safeCircle";
  // Just clear of the road so it never fights the tarmac for the same pixels, and under
  // the beams and the labels, which are drawn over the whole city.
  mesh.position.set(at.x, 0.05, at.z);
  mesh.renderOrder = 1;
  return mesh;
}

export function buildCity(map: WorldMap, assets: CityAssets, look: Look = "v1"): THREE.Group {
  const city = new THREE.Group();
  city.name = "city";

  const outskirts = new THREE.Mesh(
    flatPlane(map.size * 4),
    new THREE.MeshBasicMaterial({ color: look === "v2" ? 0x0a0e18 : 0x080b12 }),
  );
  outskirts.position.y = -0.08;
  city.add(outskirts);

  // The wet road is the one standard material in the scene. There is no reflection probe
  // behind it: the shine is the specular highlight of the two lamp lights and the warm
  // key, which is all a phone can spare and all a night street needs.
  const roadMaterial =
    look === "v2"
      ? new THREE.MeshStandardMaterial({
          map: streetTextureV2(map),
          roughnessMap: wetness(map),
          roughness: 0.85,
          metalness: 0.32,
        })
      : new THREE.MeshLambertMaterial({ map: streetTexture(map) });

  const ground = new THREE.Mesh(flatPlane(map.size), roadMaterial);
  city.add(ground);

  if (map.parks.length > 0) {
    const cell = map.lotSize + map.street;
    const half = map.size / 2;
    const grass = new THREE.InstancedMesh(
      flatPlane(map.lotSize),
      new THREE.MeshLambertMaterial({ color: PARK_COLOR }),
      map.parks.length,
    );
    const dummy = new THREE.Object3D();
    map.parks.forEach(([i, j], index) => {
      dummy.position.set(
        -half + i * cell + map.street + map.lotSize / 2,
        0.02,
        -half + j * cell + map.street + map.lotSize / 2,
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      grass.setMatrixAt(index, dummy.matrix);
    });
    grass.instanceMatrix.needsUpdate = true;
    city.add(grass);
  }

  const placed = place(map, assets);
  for (const block of facades(map, placed)) city.add(block);

  city.add(streetLamps(map));
  if (look === "v2") city.add(lampPools(map));
  city.add(windows(placed, look));
  return city;
}

/**
 * Moves whatever in the city moves: at the moment that is the failing windows. Safe to
 * call on a first look city, which has nothing to move.
 */
export function animateCity(city: THREE.Group, elapsed: number): void {
  city.traverse((child) => {
    const tick = child.userData.tick as ((at: number) => void) | undefined;
    tick?.(elapsed);
  });
}

/** Frees what buildCity made itself. The shared building assets are freed by CityAssets. */
export function disposeCity(city: THREE.Group, assets: CityAssets): void {
  const shared = new Set<THREE.BufferGeometry>(assets.buildings.map((asset) => asset.geometry));
  const keep = new Set<THREE.Material>(assets.buildings.map((asset) => asset.material));
  // The facades are welded here but their texture is not: it came with the assets and
  // goes back with them, so freeing it twice is not this function's to do.
  const keepMaps = new Set<THREE.Texture>();
  for (const asset of assets.buildings) if (asset.material.map) keepMaps.add(asset.material.map);

  city.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!shared.has(mesh.geometry)) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (keep.has(material)) continue;
      const textured = material as THREE.MeshStandardMaterial;
      if (textured.map && !keepMaps.has(textured.map)) textured.map.dispose();
      textured.roughnessMap?.dispose();
      material.dispose();
    }
  });
}
