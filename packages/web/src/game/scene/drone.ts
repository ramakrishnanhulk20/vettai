import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Place } from "../map";

/**
 * A patrol drone, built from boxes and discs rather than a model file. Three draw calls
 * each: one merged body, one InstancedMesh holding all four rotors, one beacon. The
 * geometry and the materials are shared across every drone in the scene.
 */

const ROTOR_SPEED = 26;
const BLINK_PERIOD = 1.2;
const BLINK_ON = 0.16;

type DroneParts = {
  rotors: THREE.InstancedMesh;
  beacon: THREE.Mesh;
  beaconMaterial: THREE.MeshBasicMaterial;
  halo: THREE.Sprite;
  haloMaterial: THREE.SpriteMaterial;
};

type Shared = {
  glow: THREE.Texture;
  body: THREE.BufferGeometry;
  rotor: THREE.BufferGeometry;
  beacon: THREE.BufferGeometry;
  hull: THREE.MeshLambertMaterial;
  blade: THREE.MeshBasicMaterial;
};

const ARM_POSITIONS: [number, number][] = [
  [0.74, 0.74],
  [-0.74, 0.74],
  [0.74, -0.74],
  [-0.74, -0.74],
];

/** The soft red disc behind the beacon, painted once and shared by every drone. */
function glowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser gave no 2d canvas for the beacon");

  const light = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  light.addColorStop(0, "rgba(255,255,255,1)");
  light.addColorStop(0.28, "rgba(255,110,110,0.65)");
  light.addColorStop(1, "rgba(255,40,40,0)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let shared: Shared | null = null;

function sharedAssets(): Shared {
  if (shared) return shared;

  const parts: THREE.BufferGeometry[] = [];

  parts.push(new THREE.BoxGeometry(1, 0.28, 1));

  const nose = new THREE.BoxGeometry(0.28, 0.2, 0.48);
  nose.translate(0, -0.04, 0.64);
  parts.push(nose);

  for (const [x, z] of ARM_POSITIONS) {
    const arm = new THREE.BoxGeometry(0.14, 0.11, 1);
    arm.rotateY(Math.atan2(x, z));
    arm.translate(x / 2, 0, z / 2);
    parts.push(arm);

    const pod = new THREE.BoxGeometry(0.26, 0.19, 0.26);
    pod.translate(x, 0, z);
    parts.push(pod);
  }

  const body = mergeGeometries(parts, false);
  if (!body) throw new Error("the drone body would not merge");
  for (const part of parts) part.dispose();

  shared = {
    glow: glowTexture(),
    body,
    rotor: new THREE.CylinderGeometry(0.48, 0.48, 0.02, 10),
    beacon: new THREE.SphereGeometry(0.13, 8, 6),
    hull: new THREE.MeshLambertMaterial({ color: 0x323b4d }),
    blade: new THREE.MeshBasicMaterial({
      color: 0x9fb0cc,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }),
  };
  return shared;
}

export function createDrone(): THREE.Group {
  const assets = sharedAssets();
  const drone = new THREE.Group();
  drone.name = "drone";

  drone.add(new THREE.Mesh(assets.body, assets.hull));

  const rotors = new THREE.InstancedMesh(assets.rotor, assets.blade, ARM_POSITIONS.length);
  rotors.frustumCulled = false;
  drone.add(rotors);

  const beaconMaterial = new THREE.MeshBasicMaterial({
    color: 0xff2e2e,
    transparent: true,
    opacity: 1,
    toneMapped: false,
    depthWrite: false,
  });
  const beacon = new THREE.Mesh(assets.beacon, beaconMaterial);
  beacon.position.set(0, -0.23, 0);
  drone.add(beacon);

  const haloMaterial = new THREE.SpriteMaterial({
    map: assets.glow,
    color: 0xff3a2a,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const halo = new THREE.Sprite(haloMaterial);
  halo.position.copy(beacon.position);
  halo.scale.setScalar(2.4);
  drone.add(halo);

  const parts: DroneParts = { rotors, beacon, beaconMaterial, halo, haloMaterial };
  drone.userData.parts = parts;
  animateDrone(drone, 0, false);
  return drone;
}

/** Spins the rotors and blinks the beacon. `spin` is false under reduced motion. */
export function animateDrone(drone: THREE.Group, elapsed: number, spin: boolean): void {
  const parts = drone.userData.parts as DroneParts | undefined;
  if (!parts) return;

  const angle = spin ? elapsed * ROTOR_SPEED : 0;
  const dummy = new THREE.Object3D();
  ARM_POSITIONS.forEach(([x, z], index) => {
    dummy.position.set(x, 0.15, z);
    dummy.rotation.set(0, angle + index * 0.7, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    parts.rotors.setMatrixAt(index, dummy.matrix);
  });
  parts.rotors.instanceMatrix.needsUpdate = true;

  const phase = spin ? elapsed % BLINK_PERIOD : 0;
  const lit = phase < BLINK_ON;
  parts.beaconMaterial.opacity = lit ? 1 : 0.16;
  parts.beacon.scale.setScalar(lit ? 1.5 : 1);
  parts.haloMaterial.opacity = lit ? 0.95 : 0.22;
  parts.halo.scale.setScalar(lit ? 3.6 : 2.2);
}

/**
 * Puts a drone on its loop, `travelled` metres in. The loop is the list of street
 * crossings the server sent, walked in order and closed back to the first, so a drone on
 * the hero flies the same path a drone in the live game does.
 */
export function flyPatrol(
  drone: THREE.Group,
  loop: Place[],
  travelled: number,
  height: number,
): void {
  if (loop.length < 2) return;

  const legs: number[] = [];
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    const from = loop[i] as Place;
    const to = loop[(i + 1) % loop.length] as Place;
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    legs.push(length);
    total += length;
  }
  if (total === 0) return;

  let along = ((travelled % total) + total) % total;
  let leg = 0;
  while (along > (legs[leg] as number) && leg < legs.length - 1) {
    along -= legs[leg] as number;
    leg += 1;
  }

  const from = loop[leg] as Place;
  const to = loop[(leg + 1) % loop.length] as Place;
  const span = legs[leg] as number;
  const t = span === 0 ? 0 : along / span;

  drone.position.set(from.x + (to.x - from.x) * t, height, from.z + (to.z - from.z) * t);
  // Yaw 0 looks along +z, the same convention the server uses for players.
  drone.rotation.set(0, Math.atan2(to.x - from.x, to.z - from.z), 0);
}

/** Frees the one material a drone owns on its own: the beacon dims per drone. */
export function disposeDrone(drone: THREE.Group): void {
  const parts = drone.userData.parts as DroneParts | undefined;
  parts?.beaconMaterial.dispose();
  parts?.haloMaterial.dispose();
}

/** Frees the geometry and materials every drone shares. Call once, on unmount. */
export function disposeDrones(): void {
  if (!shared) return;
  shared.glow.dispose();
  shared.body.dispose();
  shared.rotor.dispose();
  shared.beacon.dispose();
  shared.hull.dispose();
  shared.blade.dispose();
  shared = null;
}
