import * as THREE from "three";

export const NIGHT = 0x0b0f1a;

/**
 * Night over the block: a navy sky that the fog fades into, a cold hemisphere bounce off
 * the street, and one warm key low on the horizon standing in for the city glow. No
 * shadow maps anywhere, the phone pays for those twice.
 */
export function addNightLights(scene: THREE.Scene, mapSize: number): void {
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.Fog(NIGHT, mapSize * 0.04, mapSize * 0.34);

  const sky = new THREE.HemisphereLight(0x2c3f66, 0x151d2e, 0.8);
  scene.add(sky);

  const key = new THREE.DirectionalLight(0xffa463, 0.85);
  key.position.set(-40, 26, 34);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x3f6dff, 0.45);
  rim.position.set(38, 18, -30);
  scene.add(rim);
}
