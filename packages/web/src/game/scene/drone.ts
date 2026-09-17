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
 * Four draw calls: the airframe, the discs, the blur rings and the beacon are welded into
 * one mesh that spins and blinks in its own vertex shader, then the halo, the belly light
 * and the ground pool. Twelve drones on screen have to fit the draw budget.
 */

const ROTOR_SPEED = 26;
const BLINK_PERIOD = 1.2;
const BLINK_ON = 0.16;

/**
 * What the merged look's shader moves by, one set per drone: the rotor angle, the clock
 * the blur rings breathe on, whether they breathe at all, and the beacon's blink.
 */
type Drive = {
  angle: { value: number };
  time: { value: number };
  swell: { value: number };
  beaconScale: { value: number };
  beaconLit: { value: number };
};

type DroneParts = {
  /** First look only: the rotors and the beacon are their own meshes there. */
  rotors?: THREE.InstancedMesh;
  beacon?: THREE.Mesh;
  beaconMaterial?: THREE.MeshBasicMaterial;
  halo: THREE.Sprite;
  haloMaterial: THREE.SpriteMaterial;
  /** Second look only: the hull material it owns, the belly light and the pool. */
  hull?: THREE.MeshLambertMaterial;
  drive?: Drive;
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
  pool: THREE.BufferGeometry;
};

let sharedTwo: SharedTwo | null = null;

/**
 * What one part of the merged airframe is painted and moved by. `pivot` is the point a
 * rotor turns around, `rate` its share of the rotor angle, `phase` its head start,
 * `swell` how much it breathes, and `flat` lifts it out of the lighting so a blur ring
 * reads the same way an unlit material used to. `beacon` hands the part to the blink.
 */
type Coat = {
  colour: number;
  alpha: number;
  pivot?: [number, number, number];
  rate?: number;
  phase?: number;
  swell?: number;
  flat?: boolean;
  beacon?: boolean;
};

/**
 * Writes the colour and the motion of one part into its vertices. Everything the drone is
 * made of carries the same attribute set, which is what lets the parts merge into a
 * single mesh and still move apart on screen.
 */
function coat(geometry: THREE.BufferGeometry, look: Coat): THREE.BufferGeometry {
  const count = geometry.getAttribute("position").count;
  const tint = new THREE.Color(look.colour);
  const colours = new Float32Array(count * 4);
  const pivots = new Float32Array(count * 3);
  const drives = new Float32Array(count * 4);
  const beacons = new Float32Array(count);
  const [px, py, pz] = look.pivot ?? [0, 0, 0];

  for (let at = 0; at < count; at++) {
    colours[at * 4] = tint.r;
    colours[at * 4 + 1] = tint.g;
    colours[at * 4 + 2] = tint.b;
    colours[at * 4 + 3] = look.alpha;

    pivots[at * 3] = px;
    pivots[at * 3 + 1] = py;
    pivots[at * 3 + 2] = pz;

    drives[at * 4] = look.rate ?? 0;
    drives[at * 4 + 1] = look.phase ?? 0;
    drives[at * 4 + 2] = look.swell ?? 0;
    drives[at * 4 + 3] = look.flat ? 1 : 0;

    beacons[at] = look.beacon ? 1 : 0;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 4));
  geometry.setAttribute("spinPivot", new THREE.BufferAttribute(pivots, 3));
  geometry.setAttribute("spinDrive", new THREE.BufferAttribute(drives, 4));
  geometry.setAttribute("beaconMark", new THREE.BufferAttribute(beacons, 1));
  return geometry;
}

const HULL_COLOUR = 0x2a3244;
const DISC_COLOUR = 0xc8d8f2;
const RING_COLOUR = 0x9fc4ff;
const BEACON_COLOUR = 0xff2e2e;
const BEACON_AT: [number, number, number] = [0, 0.22, -0.42];

/**
 * The second look's airframe. Still boxes and cylinders, but shaped like something built
 * to fly: a flat hull, a canopy over the middle, a camera ball under the nose, arms out
 * to lit pods, and skids to land on. The rotor discs, the blur rings and the beacon ride
 * along in the same geometry, added last so they blend over the hull rather than punch
 * through it.
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

  for (const part of parts) coat(part, { colour: HULL_COLOUR, alpha: 1 });

  ARM_POSITIONS.forEach(([x, z], index) => {
    const disc = new THREE.CylinderGeometry(0.5, 0.5, 0.012, 14);
    disc.translate(x, 0.15, z);
    parts.push(
      coat(disc, {
        colour: DISC_COLOUR,
        alpha: 0.16,
        pivot: [x, 0.15, z],
        rate: 1,
        phase: index * 0.7,
        flat: true,
      }),
    );
  });

  ARM_POSITIONS.forEach(([x, z], index) => {
    const ring = new THREE.RingGeometry(0.3, 0.56, 18);
    ring.rotateX(-Math.PI / 2);
    ring.translate(x, 0.17, z);
    parts.push(
      coat(ring, {
        colour: RING_COLOUR,
        alpha: 0.14,
        pivot: [x, 0.17, z],
        rate: -0.21,
        phase: index,
        swell: 0.03,
        flat: true,
      }),
    );
  });

  const beacon = new THREE.SphereGeometry(0.11, 8, 6);
  beacon.translate(...BEACON_AT);
  parts.push(
    coat(beacon, {
      colour: BEACON_COLOUR,
      alpha: 1,
      pivot: BEACON_AT,
      flat: true,
      beacon: true,
    }),
  );

  const body = mergeGeometries(parts, false);
  if (!body) throw new Error("the drone body would not merge");
  for (const part of parts) part.dispose();

  const pool = new THREE.CircleGeometry(1, 22);
  pool.rotateX(-Math.PI / 2);

  sharedTwo = {
    beaconGlow: glowTexture(),
    whiteGlow: softGlow([
      { at: 0, colour: "rgba(255,255,255,1)" },
      { at: 0.3, colour: "rgba(214,236,255,0.5)" },
      { at: 1, colour: "rgba(150,200,255,0)" },
    ]),
    body,
    pool,
  };
  return sharedTwo;
}

/**
 * The hull material for the merged look. Each drone gets its own so the rotor uniforms
 * are its own, but the shader text is identical for all of them, so the card still
 * compiles one program. The fresnel edge is what keeps a dark drone readable against a
 * dark sky: it costs a shader variant, not a light. The parts marked flat step around the
 * lighting and the rim, which is how the discs and the rings keep the unlit look they had
 * when they were separate meshes.
 */
function hullMaterial(drive: Drive): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
  });
  addRim(material, { colour: 0x8fb6ff, strength: 0.55 });

  const rim = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    rim(shader, renderer);
    shader.uniforms.rotorAngle = drive.angle;
    shader.uniforms.rotorTime = drive.time;
    shader.uniforms.rotorSwell = drive.swell;
    shader.uniforms.beaconScale = drive.beaconScale;
    shader.uniforms.beaconLit = drive.beaconLit;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec3 spinPivot;
attribute vec4 spinDrive;
attribute float beaconMark;
uniform float rotorAngle;
uniform float rotorTime;
uniform float rotorSwell;
uniform float beaconScale;
varying float vSpinFlat;
varying float vBeaconMark;`,
      )
      .replace(
        "#include <project_vertex>",
        `float spinTurn = spinDrive.x * rotorAngle + spinDrive.y;
float spinBreath = 1.0 + sin(rotorTime * 9.0 + spinDrive.y) * spinDrive.z * rotorSwell;
vec3 spinLocal = transformed - spinPivot;
spinLocal.xz *= spinBreath;
float spinCos = cos(spinTurn);
float spinSin = sin(spinTurn);
spinLocal.xz = vec2(
  spinLocal.x * spinCos + spinLocal.z * spinSin,
  spinLocal.z * spinCos - spinLocal.x * spinSin
);
spinLocal *= mix(1.0, beaconScale, beaconMark);
transformed = spinPivot + spinLocal;
vSpinFlat = spinDrive.w;
vBeaconMark = beaconMark;
#include <project_vertex>`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float beaconLit;
varying float vSpinFlat;
varying float vBeaconMark;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `outgoingLight = mix(outgoingLight, diffuseColor.rgb, vSpinFlat);
diffuseColor.a *= mix(1.0, beaconLit, vBeaconMark);
#include <opaque_fragment>`,
      );
  };
  return material;
}

function createDroneV2(): THREE.Group {
  const assets = sharedAssetsV2();
  const drone = new THREE.Group();
  drone.name = "drone";

  const drive: Drive = {
    angle: { value: 0 },
    time: { value: 0 },
    swell: { value: 1 },
    beaconScale: { value: 1 },
    beaconLit: { value: 1 },
  };
  const hull = hullMaterial(drive);
  const frame = new THREE.Mesh(assets.body, hull);
  // The airframe is see-through only on the rotor discs, so it draws before the lights it
  // carries. That keeps the halo washing over the hull the way it did when the hull was a
  // solid mesh drawn in the pass before the sprites.
  frame.renderOrder = -1;
  drone.add(frame);

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
  halo.position.set(...BEACON_AT);
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
    halo,
    haloMaterial,
    hull,
    drive,
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

  const rotors = parts.rotors;
  if (rotors) {
    const dummy = new THREE.Object3D();
    ARM_POSITIONS.forEach(([x, z], index) => {
      dummy.position.set(x, 0.15, z);
      dummy.rotation.set(0, angle + index * 0.7, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      rotors.setMatrixAt(index, dummy.matrix);
    });
    rotors.instanceMatrix.needsUpdate = true;
  }

  const phase = spin ? elapsed % BLINK_PERIOD : 0;
  const lit = phase < BLINK_ON;

  if (parts.beacon && parts.beaconMaterial) {
    parts.beaconMaterial.opacity = lit ? 1 : 0.16;
    parts.beacon.scale.setScalar(lit ? 1.5 : 1);
  }

  // The merged look moves its own rotors and beacon: they are vertices of the one mesh,
  // and these numbers are what the shader moves them by. The rings turn the other way and
  // far slower than the discs. Two rates crossing is what the eye reads as a rotor it
  // cannot quite resolve.
  if (parts.drive) {
    parts.drive.angle.value = angle;
    parts.drive.time.value = elapsed;
    parts.drive.swell.value = spin ? 1 : 0;
    parts.drive.beaconScale.value = lit ? 1.5 : 1;
    parts.drive.beaconLit.value = lit ? 1 : 0.16;
  }

  parts.haloMaterial.opacity = lit ? 0.95 : 0.22;
  parts.halo.scale.setScalar(lit ? 3.6 : 2.2);

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
 * Where the belly light and the searchlight on the road stop earning their draw calls, and
 * where the beacon halo does. Twelve drones at four calls each is a fifth of the whole
 * frame budget, and at twenty metres the pool on the street is a smudge the size of a
 * fingernail. The halo holds all the way out to the range a blaster reaches, because a red
 * light in the dark is how a player finds the next drone.
 */
const LIGHT_FULL_M = 14;
const LIGHT_GONE_M = 20;
const HALO_FULL_M = 52;
const HALO_GONE_M = 60;

/** One at full strength, nothing past `gone`, and a straight fade in between. */
function strength(distance: number, full: number, gone: number): number {
  if (!Number.isFinite(distance) || distance <= full) return 1;
  if (distance >= gone) return 0;
  return 1 - (distance - full) / (gone - full);
}

/**
 * Trims a drone to what can actually be seen of it at this range. Run it after
 * animateDrone, which writes every light back up to full strength on each frame.
 */
export function setDroneDetail(drone: THREE.Group, distance: number): void {
  const parts = drone.userData.parts as DroneParts | undefined;
  if (!parts) return;

  const near = strength(distance, LIGHT_FULL_M, LIGHT_GONE_M);
  if (parts.under && parts.underMaterial) {
    parts.under.visible = near > 0;
    parts.underMaterial.opacity *= near;
  }
  if (parts.pool && parts.poolMaterial) {
    parts.pool.visible = near > 0;
    parts.poolMaterial.opacity *= near;
  }

  const far = strength(distance, HALO_FULL_M, HALO_GONE_M);
  parts.halo.visible = far > 0;
  parts.haloMaterial.opacity *= far;
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
  parts?.beaconMaterial?.dispose();
  parts?.haloMaterial.dispose();
  parts?.hull?.dispose();
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
    sharedTwo.pool.dispose();
    sharedTwo = null;
  }
}
