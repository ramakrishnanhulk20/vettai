import * as THREE from "three";
import type { Place, WorldMap } from "../map";
import { canvasOf, seeded } from "./materials";

/**
 * The signs on the block. Eight words painted into one atlas and welded into one mesh, so
 * the whole neon layer is two draw calls: the tubes, and the soft light they throw back
 * onto the wall behind them. The one sign with a dying transformer gets its own pair, so
 * it can buzz without dragging the other seven through a buffer upload.
 *
 * The office and the shop are named on purpose. A player who has never read the docs
 * should still know which door the job is behind.
 */

const CELL_WIDTH = 512;
const CELL_HEIGHT = 256;
const ATLAS = 1024;
const COLUMNS = ATLAS / CELL_WIDTH;

const HUNT = "#ff6a2b";
const TEAL = "#2fd4c6";
const PINK = "#ff3ea5";

type SignPlan = {
  word: string;
  colour: string;
  anchor: "office" | "shop" | "strip";
  buzz?: boolean;
};

const PLAN: SignPlan[] = [
  { word: "OFFICE", colour: HUNT, anchor: "office" },
  { word: "SHOP", colour: TEAL, anchor: "shop" },
  { word: "VETTAI", colour: HUNT, anchor: "strip" },
  { word: "BOUNTY", colour: PINK, anchor: "strip" },
  { word: "NIM", colour: TEAL, anchor: "strip" },
  { word: "OPEN 24H", colour: HUNT, anchor: "strip", buzz: true },
  { word: "HUNT", colour: HUNT, anchor: "strip" },
  { word: "PAYOUT", colour: TEAL, anchor: "strip" },
];

export type Neon = {
  group: THREE.Group;
  update: (elapsed: number) => void;
  dispose: () => void;
};

type Mount = {
  /** Which cell of the atlas this face shows, which is the sign's place in the plan. */
  atlas: number;
  centre: THREE.Vector3;
  right: THREE.Vector3;
  halfWidth: number;
  halfHeight: number;
};

function displayFace(): string {
  if (typeof window === "undefined") return '"Arial Narrow", sans-serif';
  const face = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-display-face")
    .trim();
  return face ? `${face}, "Arial Narrow", sans-serif` : '"Arial Narrow", sans-serif';
}

/** The crisp tube, and the same word again as pure blur for the wash behind it. */
function paintAtlas(ctx: CanvasRenderingContext2D, soft: boolean): void {
  const font = displayFace();
  ctx.clearRect(0, 0, ATLAS, ATLAS);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  PLAN.forEach((sign, index) => {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const x = column * CELL_WIDTH + CELL_WIDTH / 2;
    const y = row * CELL_HEIGHT + CELL_HEIGHT / 2;

    ctx.save();
    // The word is fitted to the cell rather than set at a fixed size, so a long one does
    // not run over the blur padding and bleed into the sign in the next cell.
    let size = 132;
    ctx.font = `900 ${size}px ${font}`;
    const room = CELL_WIDTH - 90;
    const measured = ctx.measureText(sign.word).width;
    if (measured > room) {
      size = Math.max(52, Math.floor((size * room) / measured));
      ctx.font = `900 ${size}px ${font}`;
    }
    ctx.shadowColor = sign.colour;

    if (soft) {
      ctx.shadowBlur = 64;
      ctx.shadowOffsetX = ATLAS * 2;
      ctx.fillStyle = sign.colour;
      ctx.globalAlpha = 0.6;
      for (let pass = 0; pass < 4; pass += 1) ctx.fillText(sign.word, x - ATLAS * 2, y);
      ctx.shadowOffsetX = 0;
    } else {
      ctx.shadowBlur = 22;
      ctx.fillStyle = sign.colour;
      for (let pass = 0; pass < 2; pass += 1) ctx.fillText(sign.word, x, y);
      // The hot core of the tube, which is what makes a neon sign read as a gas and not
      // as coloured paint.
      ctx.shadowBlur = 6;
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = 2;
      ctx.fillText(sign.word, x, y);
    }
    ctx.restore();
  });
}

function atlasTexture(soft: boolean): { texture: THREE.CanvasTexture; repaint: () => void } {
  const { canvas, ctx } = canvasOf(ATLAS);
  paintAtlas(ctx, soft);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return {
    texture,
    repaint: () => {
      paintAtlas(ctx, soft);
      texture.needsUpdate = true;
    },
  };
}

/** The building faces the signs hang on, nearest anchor first, one sign per building. */
function mounts(map: WorldMap, plan: SignPlan[]): Mount[] {
  const strip: Place = { x: (map.office.x + map.shop.x) / 2, z: (map.office.z + map.shop.z) / 2 };
  const taken = new Set<number>();
  const rng = seeded(0x4b19);
  const found: Mount[] = [];

  plan.forEach((sign, order) => {
    const anchor =
      sign.anchor === "office" ? map.office : sign.anchor === "shop" ? map.shop : strip;

    let best = -1;
    let bestRange = Infinity;
    map.buildings.forEach((building, index) => {
      if (taken.has(index)) return;
      if (building.height < 9) return;
      const cx = (building.aabb.minX + building.aabb.maxX) / 2;
      const cz = (building.aabb.minZ + building.aabb.maxZ) / 2;
      const range = Math.hypot(cx - anchor.x, cz - anchor.z);
      if (range < bestRange) {
        bestRange = range;
        best = index;
      }
    });
    if (best < 0) return;
    taken.add(best);

    const building = map.buildings[best];
    if (!building) return;
    const box = building.aabb;
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const dx = anchor.x - cx;
    const dz = anchor.z - cz;

    // The sign faces whichever way the door is, so the word is readable from the street
    // the player walks up rather than from the back alley.
    const acrossX = Math.abs(dx) >= Math.abs(dz);
    const centre = new THREE.Vector3();
    const right = new THREE.Vector3();
    let span: number;

    if (acrossX) {
      centre.x = dx >= 0 ? box.maxX + 0.14 : box.minX - 0.14;
      centre.z = cz;
      right.set(0, 0, dx >= 0 ? -1 : 1);
      span = box.maxZ - box.minZ;
    } else {
      centre.x = cx;
      centre.z = dz >= 0 ? box.maxZ + 0.14 : box.minZ - 0.14;
      right.set(dz >= 0 ? 1 : -1, 0, 0);
      span = box.maxX - box.minX;
    }

    const width = Math.min(span * 0.78, 9.5);
    const halfWidth = width / 2;
    const halfHeight = (width / (CELL_WIDTH / CELL_HEIGHT)) / 2;
    centre.y = Math.min(building.height - halfHeight - 1.2, 5.5 + rng() * 7);

    found.push({ atlas: order, centre, right, halfWidth, halfHeight });
  });

  return found;
}

/**
 * The signs as one geometry. Each one is a quad standing off the wall, with its corner
 * uvs cut straight out of the atlas, which is what lets eight different words share a
 * single material.
 */
function weld(spots: Mount[], swell: number): THREE.BufferGeometry {
  const count = spots.length;
  const positions = new Float32Array(count * 4 * 3);
  const uvs = new Float32Array(count * 4 * 2);
  const index: number[] = [];

  const corner = new THREE.Vector3();
  for (let sign = 0; sign < count; sign += 1) {
    const mount = spots[sign] as Mount;
    const column = mount.atlas % COLUMNS;
    const row = Math.floor(mount.atlas / COLUMNS);
    const u0 = (column * CELL_WIDTH) / ATLAS;
    const u1 = u0 + CELL_WIDTH / ATLAS;
    // The atlas is painted top down and sampled bottom up, so the row flips here.
    const v1 = 1 - (row * CELL_HEIGHT) / ATLAS;
    const v0 = v1 - CELL_HEIGHT / ATLAS;

    const wide = mount.halfWidth * swell;
    const tall = mount.halfHeight * swell;
    const layout: [number, number, number, number][] = [
      [-wide, -tall, u0, v0],
      [wide, -tall, u1, v0],
      [wide, tall, u1, v1],
      [-wide, tall, u0, v1],
    ];

    layout.forEach(([across, up, u, v], slot) => {
      corner.copy(mount.centre).addScaledVector(mount.right, across);
      corner.y += up;
      const at = (sign * 4 + slot) * 3;
      positions[at] = corner.x;
      positions[at + 1] = corner.y;
      positions[at + 2] = corner.z;
      uvs[(sign * 4 + slot) * 2] = u;
      uvs[(sign * 4 + slot) * 2 + 1] = v;
    });

    const base = sign * 4;
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

function signMaterial(texture: THREE.Texture, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

export function createNeon(map: WorldMap): Neon {
  const group = new THREE.Group();
  group.name = "neon";

  const spots = mounts(map, PLAN);
  const steadySpots = spots.filter((mount) => PLAN[mount.atlas]?.buzz !== true);
  const buzzSpots = spots.filter((mount) => PLAN[mount.atlas]?.buzz === true);

  const tubes = atlasTexture(false);
  const wash = atlasTexture(true);

  // The atlas is painted the moment the city is built, which on a cold load is before
  // the display face has arrived. One repaint when it lands costs nothing and is the
  // difference between the poster cut and Arial.
  if (typeof document !== "undefined" && document.fonts) {
    void document.fonts.ready.then(() => {
      tubes.repaint();
      wash.repaint();
    });
  }

  const steadyTubes = new THREE.Mesh(weld(steadySpots, 1), signMaterial(tubes.texture, 1));
  const steadyWash = new THREE.Mesh(weld(steadySpots, 1.6), signMaterial(wash.texture, 0.62));
  steadyTubes.renderOrder = 3;
  steadyWash.renderOrder = 2;
  group.add(steadyWash, steadyTubes);

  const buzzTubeMaterial = signMaterial(tubes.texture, 1);
  const buzzWashMaterial = signMaterial(wash.texture, 0.62);
  if (buzzSpots.length > 0) {
    const buzzTubes = new THREE.Mesh(weld(buzzSpots, 1), buzzTubeMaterial);
    const buzzWash = new THREE.Mesh(weld(buzzSpots, 1.6), buzzWashMaterial);
    buzzTubes.renderOrder = 3;
    buzzWash.renderOrder = 2;
    group.add(buzzWash, buzzTubes);
  }

  return {
    group,

    update(elapsed) {
      // A tube on a dying transformer is mostly lit, stutters twice a second, and drops
      // out for a beat every few seconds. Two sines and a step do all three.
      const stutter = Math.sin(elapsed * 31) * Math.sin(elapsed * 7.3);
      const outage = Math.sin(elapsed * 0.37) > 0.955 ? 0.1 : 1;
      const level = (0.72 + 0.28 * stutter) * outage;
      buzzTubeMaterial.opacity = Math.max(0.08, level);
      buzzWashMaterial.opacity = Math.max(0.04, level * 0.62);
    },

    dispose() {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | undefined;
        material?.dispose();
      });
      tubes.texture.dispose();
      wash.texture.dispose();
    },
  };
}
