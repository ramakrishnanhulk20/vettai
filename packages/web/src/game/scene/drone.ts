import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Place } from "../map";
import { addRim, glowTexture as softGlow, type Look } from "./materials";

/**
 * A patrol drone, built from boxes and discs rather than a model file. Three draw calls
 * each in the first look: one merged body, one InstancedMesh holding all four rotors,
 * one beacon. The geometry and the materials are shared across every drone in the scene.
 *
 * The second look is a real machine rather than a box: a flattened hull with a canopy
 * and a camera ball, four arms out to lit motor pods, rotor discs under blur rings, a
 * red beacon and a white underlight that puts a pool of light on the street below it.
 * Seven draw calls, and the drone is the thing the whole game is about.
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
  /** Second look only: the blur rings, the belly light and the pool it throws down. */
  blur?: THREE.InstancedMesh;
  under?: THREE.Sprite;
  underMaterial?: THREE.SpriteMaterial;
  pool?: THREE.Mesh;
  poolMaterial?: THREE.MeshBasicMaterial;
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

type SharedTwo = {
  beaconGlow: THREE.Texture;
  whiteGlow: THREE.Texture;
  body: THREE.BufferGeometry;
  rotor: THREE.BufferGeometry;
  blur: THREE.BufferGeometry;
  beacon: THREE.BufferGeometry;
  pool: THREE.BufferGeometry;
  hull: THREE.MeshLambertMaterial;
  blade: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
};

let sharedTwo: SharedTwo | null = null;

/**
 * The second look's airframe. Still boxes and cylinders, but shaped like something built
 * to fly: a flat hull, a canopy over the middle, a camera ball under the nose, arms out
 * to lit pods, and skids to land on. All of it welded into one geometry.
 */
function sharedAssetsV2(): SharedTwo {
  if (sharedTwo) return sharedTwo;

  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.BoxGeometry(0.86, 0.2, 1.24));
  parts.push(new THREE.BoxGeometry(1.2, 0.13, 0.46));

  const canopy = new THREE.SphereGeometry(0.3, 10, 6);
  canopy.scale(1, 0.55, 1.3);
  canopy.translate(0, 0.13, 0.12);
  parts.push(canopy);

  const ball = new THREE.SphereGeometry(0.15, 8, 6);
  ball.translate(0, -0.17, 0.47);
  parts.push(ball);

  for (const [x, z] of ARM_POSITIONS) {
    const arm = new THREE.BoxGeometry(0.11, 0.09, 1.04);
    arm.rotateY(Math.atan2(x, z));
    arm.translate(x * 0.52, 0.01, z * 0.52);
    parts.push(arm);

    const pod = new THREE.CylinderGeometry(0.17, 0.2, 0.18, 8);
    pod.translate(x, 0.05, z);
    parts.push(pod);

    const leg = new THREE.BoxGeometry(0.05, 0.24, 0.05);
    leg.translate(x * 0.82, -0.16, z * 0.82);
    parts.push(leg);
  }

  for (const side of [-0.62, 0.62]) {
    const skid = new THREE.BoxGeometry(0.05, 0.05, 1.42);
    skid.translate(side, -0.28, 0);
    parts.push(skid);
  }

  const body = mergeGeometries(parts, false);
  if (!body) throw new Error("the drone body would not merge");
  for (const part of parts) part.dispose();

  const blur = new THREE.RingGeometry(0.3, 0.56, 18);
  blur.rotateX(-Math.PI / 2);
  const pool = new THREE.CircleGeometry(1, 22);
  pool.rotateX(-Math.PI / 2);

  const hull = new THREE.MeshLambertMaterial({ color: 0x2a3244 });
  // The fresnel edge is what keeps a dark drone readable against a dark sky. It costs a
  // shader variant, not a light.
  addRim(hull, { colour: 0x8fb6ff, strength: 0.55 });

  sharedTwo = {
    beaconGlow: glowTexture(),
    whiteGlow: softGlow([
      { at: 0, colour: "rgba(255,255,255,1)" },
      { at: 0.3, colour: "rgba(214,236,255,0.5)" },
      { at: 1, colour: "rgba(150,200,255,0)" },
    ]),
    body,
    rotor: new THREE.CylinderGeometry(0.5, 0.5, 0.012, 14),
    blur,
    beacon: new THREE.SphereGeometry(0.11, 8, 6),
    pool,
    hull,
    blade: new THREE.MeshBasicMaterial({
      color: 0xc8d8f2,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }),
    ring: new THREE.MeshBasicMaterial({
      color: 0x9fc4ff,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  };
  return sharedTwo;
}

function createDroneV2(): THREE.Group {
  const assets = sharedAssetsV2();
  const drone = new THREE.Group();
  drone.name = "drone";

  drone.add(new THREE.Mesh(assets.body, assets.hull));

  const rotors = new THREE.InstancedMesh(assets.rotor, assets.blade, ARM_POSITIONS.length);
  rotors.frustumCulled = false;
  drone.add(rotors);

  const blur = new THREE.InstancedMesh(assets.blur, assets.ring, ARM_POSITIONS.length);
  blur.frustumCulled = false;
  blur.renderOrder = 2;
  drone.add(blur);

  const beaconMaterial = new THREE.MeshBasicMaterial({
    color: 0xff2e2e,
    transparent: true,
    opacity: 1,
    toneMapped: false,
    depthWrite: false,
  });
  const beacon = new THREE.Mesh(assets.beacon, beaconMaterial);
  beacon.position.set(0, 0.22, -0.42);
  drone.add(beacon);

  const haloMaterial = new THREE.SpriteMaterial({
    map: assets.beaconGlow,
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

  const underMaterial = new THREE.SpriteMaterial({
    map: assets.whiteGlow,
    color: 0xdceeff,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const under = new THREE.Sprite(underMaterial);
  under.position.set(0, -0.3, 0.1);
  under.scale.setScalar(1.5);
  drone.add(under);

  // The searchlight on the street is a decal, not a light. It rides under the drone and
  // widens with height, which is all the eye checks.
  const poolMaterial = new THREE.MeshBasicMaterial({
    map: assets.whiteGlow,
    color: 0xbfe0ff,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const pool = new THREE.Mesh(assets.pool, poolMaterial);
  pool.renderOrder = 2;
  drone.add(pool);

  const parts: DroneParts = {
    rotors,
    beacon,
    beaconMaterial,
    halo,
    haloMaterial,
    blur,
    under,
    underMaterial,
    pool,
    poolMaterial,
  };
  drone.userData.parts = parts;
  animateDrone(drone, 0, false);
  return drone;
}

export function createDrone(look: Look = "v1"): THREE.Group {
  if (look === "v2") return createDroneV2();

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

  const blurRings = parts.blur;
  if (blurRings) {
    // The rings turn the other way and far slower than the discs. Two rates crossing is
    // what the eye reads as a rotor it cannot quite resolve.
    ARM_POSITIONS.forEach(([x, z], index) => {
      dummy.position.set(x, 0.17, z);
      dummy.rotation.set(0, -angle * 0.21 + index, 0);
      const swell = spin ? 1 + Math.sin(elapsed * 9 + index) * 0.03 : 1;
      dummy.scale.set(swell, 1, swell);
      dummy.updateMatrix();
      blurRings.setMatrixAt(index, dummy.matrix);
    });
    blurRings.instanceMatrix.needsUpdate = true;
  }

  if (parts.pool && parts.poolMaterial) {
    const height = Math.max(drone.position.y, 0.6);
    parts.pool.position.set(0, -height + 0.07, 0);
    parts.pool.scale.setScalar(0.6 + height * 0.42);
    parts.poolMaterial.opacity = Math.max(0.06, 0.34 - height * 0.018);
  }

  if (parts.underMaterial) {
    parts.underMaterial.opacity = spin ? 0.56 + Math.sin(elapsed * 2.6) * 0.07 : 0.56;
  }
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

/** Frees the materials a drone owns on its own: its lights dim per drone. */
export function disposeDrone(drone: THREE.Group): void {
  const parts = drone.userData.parts as DroneParts | undefined;
  parts?.beaconMaterial.dispose();
  parts?.haloMaterial.dispose();
  parts?.underMaterial?.dispose();
  parts?.poolMaterial?.dispose();
}

/** Frees the geometry and materials every drone shares. Call once, on unmount. */
export function disposeDrones(): void {
  if (shared) {
    shared.glow.dispose();
    shared.body.dispose();
    shared.rotor.dispose();
    shared.beacon.dispose();
    shared.hull.dispose();
    shared.blade.dispose();
    shared = null;
  }

  if (sharedTwo) {
    sharedTwo.beaconGlow.dispose();
    sharedTwo.whiteGlow.dispose();
    sharedTwo.body.dispose();
    sharedTwo.rotor.dispose();
    sharedTwo.blur.dispose();
    sharedTwo.beacon.dispose();
    sharedTwo.pool.dispose();
    sharedTwo.hull.dispose();
    sharedTwo.blade.dispose();
    sharedTwo.ring.dispose();
    sharedTwo = null;
  }
}
