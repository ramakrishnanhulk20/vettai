import * as THREE from "three";

/**
 * What the second look is made of: the renderer tuning, the palette every new module
 * paints from, and the handful of canvas textures they share. Nothing here runs for the
 * first look, so the live game keeps the picture it has until the flag is flipped.
 */

export type Look = "v1" | "v2";

export const PALETTE = {
  night: 0x0b0f1a,
  zenith: 0x080c17,
  horizon: 0x4a1f08,
  glow: 0xff6a2b,
  teal: 0x2fd4c6,
  moon: 0xf2ece0,
  asphalt: 0x141a25,
  pavement: 0x1f2634,
  lamp: 0xffb070,
  windowWarm: [0xffb35c, 0xffc98a, 0xff9d4a] as const,
  windowCold: 0xbcd6ff,
  /** Four cool concretes, handed out by building type so no two neighbours match. */
  facade: [0x8f99ad, 0x7d8aa4, 0x99a4b7, 0x707f9a] as const,
} as const;

/** Same seeded generator on every load, so nothing in the look moves between visits. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvasOf(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser gave no 2d canvas for the city look");
  return { canvas, ctx };
}

/**
 * The renderer both looks are drawn under. The second look is graded a little darker so
 * the neon and the lamp heads have somewhere to go before they clip to white.
 */
export function tuneRenderer(renderer: THREE.WebGLRenderer, look: Look): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = look === "v2" ? 1.1 : 1.18;
  renderer.setClearColor(PALETTE.night, 1);
}

export type GlowStop = { at: number; colour: string };

/** A soft round blob, which is every light pool, halo and ember in this scene. */
export function glowTexture(stops: GlowStop[], size = 128): THREE.CanvasTexture {
  const { canvas, ctx } = canvasOf(size);
  const half = size / 2;
  const light = ctx.createRadialGradient(half, half, 0, half, half, half);
  for (const stop of stops) light.addColorStop(stop.at, stop.colour);
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Grey noise, softened by drawing it small and letting the card stretch it. The road
 * reads it as roughness and the haze reads it as thickness, so one tile serves both.
 */
export function noiseTexture(seed: number, size = 128, contrast = 0.5): THREE.CanvasTexture {
  const { canvas, ctx } = canvasOf(size);
  const rng = seeded(seed);
  const image = ctx.createImageData(size, size);
  const mid = 255 * (1 - contrast) * 0.5;
  for (let at = 0; at < image.data.length; at += 4) {
    const shade = Math.round(mid + rng() * 255 * contrast + (255 - mid - 255 * contrast) * 0.5);
    image.data[at] = shade;
    image.data[at + 1] = shade;
    image.data[at + 2] = shade;
    image.data[at + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  // Drawn back over itself at four times the size: per pixel noise on a road is sparkle,
  // blurred noise is wet tarmac.
  ctx.globalAlpha = 0.85;
  ctx.filter = "blur(2px)";
  ctx.drawImage(canvas, 0, 0, size, size);
  ctx.filter = "none";
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * A fresnel edge added to a Lambert material, so a body reads as a silhouette against a
 * dark street without a second light or a second pass. `band` lifts a narrow height in
 * the accent, which is the trim across the shoulders.
 */
export function addRim(
  material: THREE.MeshLambertMaterial,
  options: { colour: number; strength: number; band?: { at: number; width: number; colour: number } },
): void {
  const rim = new THREE.Color(options.colour).convertSRGBToLinear();
  const band = options.band;
  const trim = new THREE.Color(band?.colour ?? options.colour).convertSRGBToLinear();

  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColour = { value: rim };
    shader.uniforms.rimStrength = { value: options.strength };
    shader.uniforms.trimColour = { value: trim };
    shader.uniforms.trimAt = { value: band?.at ?? -1 };
    shader.uniforms.trimWidth = { value: band?.width ?? 0.1 };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vLookHeight;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvLookHeight = (modelMatrix * vec4(transformed, 1.0)).y;",
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 rimColour;
uniform float rimStrength;
uniform vec3 trimColour;
uniform float trimAt;
uniform float trimWidth;
varying float vLookHeight;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `float lookFacing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
float lookRim = pow(1.0 - lookFacing, 3.0) * rimStrength;
outgoingLight += rimColour * lookRim;
if (trimAt > 0.0) {
  float lookBand = 1.0 - smoothstep(0.0, trimWidth, abs(vLookHeight - trimAt));
  outgoingLight += trimColour * lookBand * 0.5;
}
#include <opaque_fragment>`,
      );
  };
  material.needsUpdate = true;
}
