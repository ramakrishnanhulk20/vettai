import * as THREE from "three";
import type { BuildingAsset, CityAssets } from "./assets";
import type { WorldMap } from "../map";

/**
 * The block, drawn from the map the server generated. One InstancedMesh per building type
 * keeps the whole city inside about two dozen draw calls, which is the budget the live
 * game has to share on a phone.
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
function windows(placed: Placed[]): THREE.Group {
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
    new THREE.MeshBasicMaterial({
      color: WINDOW_COLOR,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      toneMapped: false,
    }),
    matrices.length,
  );

  const wide = new THREE.Matrix4();
  const halo = new THREE.Matrix4().makeScale(2.3, 1.9, 1);
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
  return group;
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

export function buildCity(map: WorldMap, assets: CityAssets): THREE.Group {
  const city = new THREE.Group();
  city.name = "city";

  const outskirts = new THREE.Mesh(
    flatPlane(map.size * 4),
    new THREE.MeshBasicMaterial({ color: 0x080b12 }),
  );
  outskirts.position.y = -0.08;
  city.add(outskirts);

  const ground = new THREE.Mesh(
    flatPlane(map.size),
    new THREE.MeshLambertMaterial({ map: streetTexture(map) }),
  );
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
  const byType = new Map<BuildingAsset, Placed[]>();
  for (const item of placed) {
    const list = byType.get(item.asset);
    if (list) list.push(item);
    else byType.set(item.asset, [item]);
  }

  for (const [asset, items] of byType) {
    const mesh = new THREE.InstancedMesh(asset.geometry, asset.material, items.length);
    items.forEach((item, index) => mesh.setMatrixAt(index, item.matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    city.add(mesh);
  }

  city.add(streetLamps(map));
  city.add(windows(placed));
  return city;
}

/** Frees what buildCity made itself. The shared building assets are freed by CityAssets. */
export function disposeCity(city: THREE.Group, assets: CityAssets): void {
  const shared = new Set<THREE.BufferGeometry>(assets.buildings.map((asset) => asset.geometry));
  const keep = new Set<THREE.Material>(assets.buildings.map((asset) => asset.material));

  city.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!shared.has(mesh.geometry)) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (keep.has(material)) continue;
      const lambert = material as THREE.MeshLambertMaterial;
      lambert.map?.dispose();
      material.dispose();
    }
  });
}
