import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type Look, PALETTE } from "./materials";

/** One building type, ready to instance: base at y 0, centred on x and z. */
export type BuildingAsset = {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;
  footprint: number;
  height: number;
};

export type CityAssets = {
  buildings: BuildingAsset[];
  dispose(): void;
};

export const BUILDING_TYPES = 20;

const MODEL_PATH = "/models/buildings";

function modelUrl(type: number): string {
  return `${MODEL_PATH}/b${String(type).padStart(2, "0")}.glb`;
}

function firstMesh(root: THREE.Object3D): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  root.traverse((child) => {
    if (!found && (child as THREE.Mesh).isMesh) found = child as THREE.Mesh;
  });
  if (!found) throw new Error("that building model has no mesh in it");
  return found;
}

/**
 * Bakes the node transform into the vertices and moves the model so its base sits on the
 * ground and its footprint is centred, which is what an InstancedMesh matrix expects.
 */
function groundGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const geometry = mesh.geometry.clone();
  mesh.updateWorldMatrix(true, false);
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingBox();

  const box = geometry.boundingBox;
  if (!box) throw new Error("that building model has no bounds");
  geometry.translate(
    -(box.min.x + box.max.x) / 2,
    -box.min.y,
    -(box.min.z + box.max.z) / 2,
  );
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Lambert rather than the standard material the file ships with: the city is lit by two
 * directionals and a hemisphere, nothing is metal, and the cheaper shader is the
 * difference between 60 and 40 frames a second on a mid phone.
 */
function nightMaterial(source: THREE.Material): THREE.MeshLambertMaterial {
  const map = (source as THREE.MeshStandardMaterial).map ?? null;
  if (map) map.anisotropy = 1;
  return new THREE.MeshLambertMaterial({ map, color: 0x8b95ab });
}

/**
 * A tower is one flat value under a hemisphere light, which is why the block used to read
 * as cardboard. The second look gives each type its own concrete, a rough standard shader
 * so the lamps and the neon leave a sheen on the walls, and a gradient baked into the
 * vertices that sinks the first few floors into the street's own shadow. No new texture
 * and no new draw call: the instancing is untouched.
 */
function facadeMaterial(source: THREE.Material, type: number): THREE.MeshStandardMaterial {
  const map = (source as THREE.MeshStandardMaterial).map ?? null;
  if (map) map.anisotropy = 1;
  const tint = PALETTE.facade[type % PALETTE.facade.length] ?? 0x8f99ad;
  return new THREE.MeshStandardMaterial({
    map,
    color: tint,
    roughness: 0.85,
    metalness: 0.06,
    vertexColors: true,
  });
}

/** How dark the wall is where it meets the pavement, and how fast it climbs out of it. */
const FOOT_SHADE = 0.4;
const CLIMB = 0.55;

function shadeFacade(geometry: THREE.BufferGeometry, height: number): void {
  const spots = geometry.getAttribute("position");
  const shades = new Float32Array(spots.count * 3);
  const tall = Math.max(height, 0.001);

  for (let point = 0; point < spots.count; point += 1) {
    const lift = Math.min(Math.max(spots.getY(point) / tall, 0), 1);
    const shade = FOOT_SHADE + (1 - FOOT_SHADE) * Math.pow(lift, CLIMB);
    shades[point * 3] = shade;
    shades[point * 3 + 1] = shade;
    shades[point * 3 + 2] = shade;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(shades, 3));
}

export async function loadCityAssets(
  onProgress?: (done: number, total: number) => void,
  look: Look = "v1",
): Promise<CityAssets> {
  // Every building file points at the same colormap.png; without the cache the browser
  // asks the server for it once per model.
  THREE.Cache.enabled = true;
  const loader = new GLTFLoader();
  const buildings: BuildingAsset[] = new Array(BUILDING_TYPES);
  let done = 0;

  // Four at a time: enough to keep the connection busy, few enough that a phone on a
  // slow link still reports progress that moves.
  const queue = Array.from({ length: BUILDING_TYPES }, (_, type) => type);
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const type = queue.shift();
      if (type === undefined) return;

      const gltf = await loader.loadAsync(modelUrl(type));
      const mesh = firstMesh(gltf.scene);
      const geometry = groundGeometry(mesh);
      const box = geometry.boundingBox;
      if (!box) throw new Error("that building model has no bounds");

      const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (look === "v2") shadeFacade(geometry, box.max.y);

      buildings[type] = {
        geometry,
        material: look === "v2" ? facadeMaterial(source, type) : nightMaterial(source),
        footprint: Math.max(box.max.x - box.min.x, box.max.z - box.min.z),
        height: box.max.y,
      };

      done += 1;
      onProgress?.(done, BUILDING_TYPES);
    }
  });

  await Promise.all(workers);

  return {
    buildings,
    dispose() {
      for (const asset of buildings) {
        asset.geometry.dispose();
        asset.material.map?.dispose();
        asset.material.dispose();
      }
    },
  };
}
