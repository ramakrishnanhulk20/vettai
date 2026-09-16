import * as THREE from "three";
import type { Look } from "./materials";

export const NIGHT = 0x0b0f1a;

/**
 * Night over the block: a navy sky that the fog fades into, a bounce off the street warm
 * enough to read the road by, and one warm key low on the horizon standing in for the
 * city glow. No shadow maps anywhere, the phone pays for those twice.
 */
export function addNightLights(scene: THREE.Scene, mapSize: number, look: Look = "v1"): void {
  if (look === "v2") {
    addSecondLook(scene);
    return;
  }

  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.Fog(NIGHT, mapSize * 0.04, mapSize * 0.34);

  const sky = new THREE.HemisphereLight(0x33486f, 0x2b3346, 0.95);
  scene.add(sky);

  const key = new THREE.DirectionalLight(0xffa463, 0.85);
  key.position.set(-40, 26, 34);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x3f6dff, 0.45);
  rim.position.set(38, 18, -30);
  scene.add(rim);
}

/** Where the moon hangs and where the city burns, matching atmosphere.ts. */
const MOON_WAY = new THREE.Vector3(-0.62, 0.17, 0.77).normalize();
const GLOW_WAY = new THREE.Vector3(0.82, 0.22, -0.57).normalize();

/**
 * The second look's night. Same three lights as the first, so the shader cost is
 * unchanged, but graded: a dimmer bounce for deeper shadow, a warm key sitting exactly
 * where the sky burns orange, and a cold key out of the moon so anything walking has an
 * edge on it. The fog turns exponential, which is what makes distance read as depth
 * instead of a curtain at a fixed range.
 */
function addSecondLook(scene: THREE.Scene): void {
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.FogExp2(0x0c111d, 0.0115);

  const sky = new THREE.HemisphereLight(0x2b3d63, 0x141a26, 0.6);
  scene.add(sky);

  const glow = new THREE.DirectionalLight(0xff9a5a, 0.62);
  glow.position.copy(GLOW_WAY).multiplyScalar(60);
  scene.add(glow);

  const moon = new THREE.DirectionalLight(0xbfd4ff, 0.6);
  moon.position.copy(MOON_WAY).multiplyScalar(60);
  scene.add(moon);
}

/** How high the warm pool sits, which is the height of a lamp head. */
const LAMP_HEIGHT = 4.1;
const LAMP_COLOUR = 0xffb070;
const LAMP_INTENSITY = 22;
const LAMP_REACH = 20;

export type LampGlow = {
  /** Moves the two lights to the two nearest lamps. `spots` is x and z, pair by pair. */
  update: (spots: Float32Array, x: number, z: number) => void;
  dispose: () => void;
};

/**
 * Two real lights for a street full of lamps.
 *
 * A point light per lamp would be hundreds of lights and a shader recompile the phone
 * cannot afford, so the city carries the lamps as geometry and only the two nearest the
 * player are lit. The player never sees the swap: a lamp is out of the pool's reach long
 * before it hands its light over.
 */
export function addLampGlow(scene: THREE.Scene): LampGlow {
  const lights = [0, 1].map(() => {
    const light = new THREE.PointLight(LAMP_COLOUR, LAMP_INTENSITY, LAMP_REACH, 2);
    light.visible = false;
    scene.add(light);
    return light;
  });

  return {
    update(spots, x, z) {
      let bestOne = -1;
      let bestTwo = -1;
      let rangeOne = Infinity;
      let rangeTwo = Infinity;

      for (let index = 0; index < spots.length; index += 2) {
        const dx = (spots[index] as number) - x;
        const dz = (spots[index + 1] as number) - z;
        const range = dx * dx + dz * dz;
        if (range < rangeOne) {
          rangeTwo = rangeOne;
          bestTwo = bestOne;
          rangeOne = range;
          bestOne = index;
        } else if (range < rangeTwo) {
          rangeTwo = range;
          bestTwo = index;
        }
      }

      const place = (light: THREE.PointLight, at: number) => {
        if (at < 0) {
          light.visible = false;
          return;
        }
        light.position.set(spots[at] as number, LAMP_HEIGHT, spots[at + 1] as number);
        light.visible = true;
      };

      place(lights[0] as THREE.PointLight, bestOne);
      place(lights[1] as THREE.PointLight, bestTwo);
    },

    dispose() {
      for (const light of lights) scene.remove(light);
    },
  };
}
