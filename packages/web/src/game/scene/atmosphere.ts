import * as THREE from "three";
import type { WorldMap } from "../map";
import { glowTexture, noiseTexture, PALETTE, seeded } from "./materials";

/**
 * Everything past the last building: the graded sky, the stars, the moon, the ring of
 * far towers that stops the block ending in grey, and the two cheap volumetric tricks
 * near the player, knee high haze and drifting embers.
 *
 * The whole lot rides with the camera in x and z, so the horizon behaves the way a real
 * one does: you never walk up to it. Six draw calls for the entire world beyond the map.
 */

const DOME_RADIUS = 460;
const STAR_COUNT = 420;
const SKYLINE_COUNT = 88;
const EMBER_COUNT = 60;
const HAZE_SPAN = 240;

/** Where the city burns brightest on the horizon, and where the moon hangs. */
const GLOW_DIRECTION = new THREE.Vector3(0.82, 0, -0.57).normalize();
const MOON_DIRECTION = new THREE.Vector3(-0.62, 0.17, 0.77).normalize();

export type Atmosphere = {
  group: THREE.Group;
  /** `focus` is wherever the shot is. The sky, the haze and the embers follow it. */
  update: (elapsed: number, focus: THREE.Vector3) => void;
  dispose: () => void;
};

function skyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(DOME_RADIUS, 24, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenithColour: { value: new THREE.Color(PALETTE.zenith) },
      bandColour: { value: new THREE.Color(0x1a1f30) },
      glowColour: { value: new THREE.Color(PALETTE.horizon) },
      glowDirection: { value: GLOW_DIRECTION },
    },
    vertexShader: [
      "varying vec3 vRay;",
      "void main() {",
      "  vRay = position;",
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
      "}",
    ].join("\n"),
    // The two chunks at the end are the tone mapping and the colour space the rest of
    // the scene is drawn under. A shader material skips both unless it asks for them,
    // and a sky that skipped them would be the one thing in frame that is not graded.
    fragmentShader: [
      "uniform vec3 zenithColour;",
      "uniform vec3 bandColour;",
      "uniform vec3 glowColour;",
      "uniform vec3 glowDirection;",
      "varying vec3 vRay;",
      "void main() {",
      "  vec3 ray = normalize(vRay);",
      "  float lift = smoothstep(-0.06, 0.62, ray.y);",
      "  vec3 sky = mix(bandColour, zenithColour, lift);",
      "  float hug = pow(1.0 - clamp(abs(ray.y) * 5.0, 0.0, 1.0), 2.2);",
      "  float facing = clamp(dot(normalize(vec3(ray.x, 0.0, ray.z)), glowDirection), 0.0, 1.0);",
      "  sky += glowColour * hug * (0.34 + 1.25 * facing * facing);",
      "  gl_FragColor = vec4(sky, 1.0);",
      "  #include <tonemapping_fragment>",
      "  #include <colorspace_fragment>",
      "}",
    ].join("\n"),
  });

  const dome = new THREE.Mesh(geometry, material);
  dome.name = "sky";
  dome.renderOrder = -2;
  dome.frustumCulled = false;
  return dome;
}

function stars(): THREE.Points {
  const rng = seeded(0x5ee7);
  const positions = new Float32Array(STAR_COUNT * 3);
  const colours = new Float32Array(STAR_COUNT * 3);
  const tint = new THREE.Color();

  for (let index = 0; index < STAR_COUNT; index += 1) {
    const angle = rng() * Math.PI * 2;
    // The power curve thins the field overhead and crowds it near the horizon, the way
    // city light and haze actually leave it.
    const lift = 0.04 + Math.pow(rng(), 1.7) * 0.9;
    const flat = Math.sqrt(Math.max(0, 1 - lift * lift));
    const radius = DOME_RADIUS * 0.94;
    positions[index * 3] = Math.cos(angle) * flat * radius;
    positions[index * 3 + 1] = lift * radius;
    positions[index * 3 + 2] = Math.sin(angle) * flat * radius;

    const warm = rng();
    tint.setHex(warm > 0.88 ? 0xffd9b0 : warm > 0.72 ? 0xbcd6ff : 0xf2efe6);
    const fade = 0.35 + rng() * 0.65;
    colours[index * 3] = tint.r * fade;
    colours[index * 3 + 1] = tint.g * fade;
    colours[index * 3 + 2] = tint.b * fade;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));

  const field = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      map: glowTexture(
        [
          { at: 0, colour: "rgba(255,255,255,1)" },
          { at: 0.35, colour: "rgba(255,255,255,0.5)" },
          { at: 1, colour: "rgba(255,255,255,0)" },
        ],
        32,
      ),
      size: 3.2,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    }),
  );
  field.name = "stars";
  field.renderOrder = -1;
  field.frustumCulled = false;
  return field;
}

function moon(): THREE.Sprite {
  const texture = glowTexture(
    [
      { at: 0, colour: "rgba(255,252,244,1)" },
      { at: 0.17, colour: "rgba(242,236,224,0.98)" },
      { at: 0.2, colour: "rgba(226,222,210,0.3)" },
      { at: 0.46, colour: "rgba(190,200,220,0.11)" },
      { at: 1, colour: "rgba(120,150,210,0)" },
    ],
    256,
  );

  const disc = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    }),
  );
  disc.name = "moon";
  disc.position.copy(MOON_DIRECTION).multiplyScalar(DOME_RADIUS * 0.9);
  disc.scale.setScalar(96);
  disc.renderOrder = -1;
  return disc;
}

/**
 * The far city: one instanced box per tower, standing in a ring the camera carries with
 * it. Fog is off and the shade is baked in per tower, because at this range exponential
 * fog would swallow the ring whole and the world would end in navy again.
 */
function skyline(): THREE.InstancedMesh {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser gave no 2d canvas for the skyline");

  ctx.fillStyle = "#0c111c";
  ctx.fillRect(0, 0, 64, 128);
  const lit = seeded(0x9a13);
  for (let row = 0; row < 26; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      if (lit() > 0.17) continue;
      ctx.fillStyle = lit() > 0.2 ? "rgba(255,183,110,0.85)" : "rgba(188,214,255,0.7)";
      ctx.fillRect(5 + column * 8, 6 + row * 4.6, 3.4, 2.4);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const towers = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ map: texture, fog: false }),
    SKYLINE_COUNT,
  );
  towers.name = "skyline";
  towers.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const shade = new THREE.Color();
  const far = new THREE.Color(0x0d1523);
  const rng = seeded(0x31c7);
  for (let index = 0; index < SKYLINE_COUNT; index += 1) {
    const angle = (index / SKYLINE_COUNT) * Math.PI * 2 + rng() * 0.06;
    const radius = 300 + rng() * 130;
    const height = 24 + Math.pow(rng(), 1.6) * 130;
    dummy.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    dummy.rotation.set(0, -angle, 0);
    dummy.scale.set(16 + rng() * 34, height, 16 + rng() * 24);
    dummy.updateMatrix();
    towers.setMatrixAt(index, dummy.matrix);

    // The ones further out sit closer to the sky they are cut out of, which is what
    // reads as distance once there is no fog left to do it.
    shade.setHex(0x151d2c).lerp(far, (radius - 300) / 130);
    towers.setColorAt(index, shade);
  }
  towers.instanceMatrix.needsUpdate = true;
  if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
  return towers;
}

function haze(): THREE.Mesh {
  const texture = noiseTexture(0x77a1, 128, 0.85);
  texture.repeat.set(4, 4);

  const plane = new THREE.PlaneGeometry(HAZE_SPAN, HAZE_SPAN);
  plane.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    plane,
    new THREE.MeshBasicMaterial({
      map: texture,
      color: 0x2c4a7a,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  mesh.name = "haze";
  mesh.position.y = 0.9;
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return mesh;
}

function embers(): THREE.Points {
  const rng = seeded(0x1f0b);
  const positions = new Float32Array(EMBER_COUNT * 3);
  const drift = new Float32Array(EMBER_COUNT * 3);
  for (let index = 0; index < EMBER_COUNT; index += 1) {
    // Scattered in a ring rather than a box: an ember that spawns on the lens is a
    // bubble, and the cloud is meant to sit between the camera and the street.
    const angle = rng() * Math.PI * 2;
    const radius = 7 + rng() * 12;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = rng() * 9;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    drift[index * 3] = (rng() - 0.5) * 0.5;
    drift[index * 3 + 1] = 0.25 + rng() * 0.5;
    drift[index * 3 + 2] = (rng() - 0.5) * 0.5;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const cloud = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      map: glowTexture([
        { at: 0, colour: "rgba(255,226,180,1)" },
        { at: 0.3, colour: "rgba(255,138,60,0.7)" },
        { at: 1, colour: "rgba(255,90,20,0)" },
      ]),
      size: 0.3,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  cloud.name = "embers";
  cloud.frustumCulled = false;
  cloud.userData.drift = drift;
  return cloud;
}

export function createAtmosphere(_map: WorldMap): Atmosphere {
  const group = new THREE.Group();
  group.name = "atmosphere";

  const dome = skyDome();
  const field = stars();
  const disc = moon();
  const towers = skyline();
  const fog = haze();
  const sparks = embers();
  group.add(dome, field, disc, towers, fog, sparks);

  const drift = sparks.userData.drift as Float32Array;
  const spots = sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
  const source = new Float32Array(spots.array as Float32Array);
  const hazeMap = (fog.material as THREE.MeshBasicMaterial).map;
  let lastElapsed = 0;

  return {
    group,

    update(elapsed, focus) {
      const step = Math.min(Math.max(elapsed - lastElapsed, 0), 0.1);
      lastElapsed = elapsed;

      group.position.set(focus.x, 0, focus.z);
      if (hazeMap) {
        // The haze belongs to the ground, not to the group that follows the camera, so
        // its texture is scrolled back by exactly as far as the group moved forward.
        hazeMap.offset.set(
          (focus.x / HAZE_SPAN) * 4 + elapsed * 0.004,
          (-focus.z / HAZE_SPAN) * 4 + elapsed * 0.0025,
        );
      }

      const points = spots.array as Float32Array;
      for (let index = 0; index < EMBER_COUNT; index += 1) {
        const at = index * 3;
        points[at] = (points[at] as number) + (drift[at] as number) * step;
        points[at + 1] = (points[at + 1] as number) + (drift[at + 1] as number) * step;
        points[at + 2] = (points[at + 2] as number) + (drift[at + 2] as number) * step;
        // Back down to where it was lit once it clears the rooftops, so the same sixty
        // embers keep the street company all night.
        if ((points[at + 1] as number) > 11) {
          points[at] = source[at] as number;
          points[at + 1] = 0.2;
          points[at + 2] = source[at + 2] as number;
        }
      }
      spots.needsUpdate = true;
    },

    dispose() {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!material) return;
        for (const one of Array.isArray(material) ? material : [material]) {
          (one as THREE.MeshBasicMaterial).map?.dispose();
          one.dispose();
        }
      });
    },
  };
}
