"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useReducedMotion } from "framer-motion";
import { fetchWorldMap, PATROL_Y, type Place, type WorldMap } from "@/game/map";
import { loadCityAssets, type CityAssets } from "@/game/scene/assets";
import { buildCity, disposeCity } from "@/game/scene/city";
import {
  animateDrone,
  createDrone,
  disposeDrone,
  disposeDrones,
  flyPatrol,
} from "@/game/scene/drone";
import { addNightLights, NIGHT } from "@/game/scene/lights";
import { scenePixelRatio } from "@/game/scene/pixelRatio";

/**
 * The hero shot: the same city the game runs in, flown by a camera that never stops. It
 * reads the block from the world server, so the skyline on the landing page is the
 * skyline a player lands in.
 */

const DRONE_COUNT = 8;
const DRONE_SPEED = 3;
const CAMERA_SPEED = 1.5;
const RUN_LENGTH = 96;
const DESKTOP_EYE = 4;
const PHONE_EYE = 6;

type Phase = "loading" | "running" | "offline" | "unsupported";

function webglWorks(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

function eyeHeight(): number {
  return window.innerWidth < 768 ? PHONE_EYE : DESKTOP_EYE;
}

/** Zero at the ends, so the camera slows into each turnaround instead of snapping. */
function smoothPingPong(phase: number): number {
  return (1 - Math.cos(phase * Math.PI * 2)) / 2;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

type Leg = {
  loop: Place[];
  index: number;
  start: THREE.Vector3;
  forward: THREE.Vector3;
  length: number;
  at: number;
};

/**
 * The longest straight stretch any patrol flies. The camera runs down it, so the shot is a
 * street the drones actually use rather than a street picked by hand.
 */
function longestLeg(loops: Place[][]): Leg | null {
  let best: Leg | null = null;

  loops.forEach((loop, index) => {
    let travelled = 0;
    for (let step = 0; step < loop.length; step++) {
      const from = loop[step] as Place;
      const to = loop[(step + 1) % loop.length] as Place;
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      if (length > 0 && (!best || length > best.length)) {
        best = {
          loop,
          index,
          start: new THREE.Vector3(from.x, 0, from.z),
          forward: new THREE.Vector3((to.x - from.x) / length, 0, (to.z - from.z) / length),
          length,
          at: travelled,
        };
      }
      travelled += length;
    }
  });

  return best;
}

/** How far round its loop each drone starts, in metres. */
function heads(count: number, loops: Place[][], leg: Leg | null): number[] {
  const spread: number[] = [];
  for (let index = 0; index < count; index++) {
    const loop = index % loops.length;
    if (leg && loop === leg.index) {
      // Four drones share the camera's loop: the first one is already in the shot, the
      // rest are spaced back down the loop so another arrives every half minute.
      const rank = Math.floor(index / loops.length);
      spread.push(leg.at + 12 - rank * 84);
    } else {
      spread.push(index * 37);
    }
  }
  return spread;
}

export default function CityCanvas() {
  const holder = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [percent, setPercent] = useState(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    const mount = holder.current;
    if (!mount) return;

    if (!webglWorks()) {
      setPhase("unsupported");
      return;
    }

    let stopped = false;
    let assets: CityAssets | null = null;
    let city: THREE.Group | null = null;
    const fleet: THREE.Group[] = [];
    const abort = new AbortController();

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    mount.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: window.innerWidth >= 768,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(scenePixelRatio());
    renderer.setClearColor(NIGHT, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(54, 1, 0.5, 520);

    const redraw: { current: (() => void) | null } = { current: null };

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      renderer.setPixelRatio(scenePixelRatio());
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // Three measures the field of view vertically, so a portrait phone would otherwise
      // trade the street for a band of empty sky.
      camera.fov = camera.aspect < 1 ? 66 : 54;
      camera.updateProjectionMatrix();
      redraw.current?.();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const frameRef: { current: (() => void) | null } = { current: null };

    const start = async () => {
      let map: WorldMap;
      try {
        map = await fetchWorldMap(abort.signal);
        assets = await loadCityAssets((done, total) => {
          if (!stopped) setPercent(Math.round((done / total) * 100));
        });
      } catch {
        if (!stopped) setPhase("offline");
        return;
      }
      if (stopped || !assets) return;

      addNightLights(scene, map.size);
      city = buildCity(map, assets);
      scene.add(city);

      const loops = map.patrols;
      const leg = longestLeg(loops);
      const offsets = heads(DRONE_COUNT, loops, leg);
      for (let index = 0; index < DRONE_COUNT && loops.length > 0; index++) {
        const drone = createDrone();
        drone.userData.loop = loops[index % loops.length];
        drone.userData.head = offsets[index] ?? index * 37;
        drone.userData.lift = PATROL_Y + (index % 3) * 0.6;
        scene.add(drone);
        fleet.push(drone);
      }

      const run = leg ? Math.min(leg.length - 8, RUN_LENGTH) : RUN_LENGTH;
      const forward = leg
        ? leg.forward.clone()
        : new THREE.Vector3(0, 0, 1);
      const from = leg
        ? leg.start.clone().addScaledVector(forward, (leg.length - run) / 2)
        : new THREE.Vector3(map.office.x, 0, map.office.z - run / 2);
      from.y = eyeHeight();
      const to = from.clone().addScaledVector(forward, run);
      const up = new THREE.Vector3(0, 1, 0);
      const heading = new THREE.Vector3();
      const cycle = (2 * run) / CAMERA_SPEED;
      const look = new THREE.Vector3();
      let last = performance.now();
      let elapsed = 0;

      const frame = () => {
        const now = performance.now();
        const delta = Math.min((now - last) / 1000, 0.05);
        last = now;
        if (!reduced) elapsed += delta;

        const eye = eyeHeight();
        const phaseOfRun = (elapsed / cycle) % 1;
        const along = smoothPingPong(phaseOfRun);
        camera.position.lerpVectors(from, to, along);
        camera.position.y = eye;

        // The camera turns while it is nearly stopped, so the swing reads as a pan.
        const way = clamp(Math.sin(phaseOfRun * Math.PI * 2) * 3, -1, 1);
        const turn = ((1 - way) / 2) * Math.PI + Math.sin(elapsed * 0.11) * 0.16;
        heading.copy(forward).applyAxisAngle(up, turn);
        look.copy(camera.position).addScaledVector(heading, 24);
        // Portrait looks further up the walls: a phone sees a narrow slice of the street,
        // and the towers are what fills it.
        look.y = eye + (camera.aspect < 1 ? 3.6 : 1.2);
        camera.lookAt(look);

        for (const drone of fleet) {
          const loop = drone.userData.loop as Place[];
          const head = drone.userData.head as number;
          const lift = drone.userData.lift as number;
          flyPatrol(drone, loop, head + elapsed * DRONE_SPEED, lift);
          animateDrone(drone, elapsed, !reduced);
        }

        renderer.render(scene, camera);
      };

      if (stopped) return;
      redraw.current = frame;
      setPhase("running");

      // Reduced motion gets the city drawn once and left alone, rather than a still scene
      // redrawn sixty times a second for nothing.
      if (reduced) {
        frame();
      } else {
        frameRef.current = frame;
        if (!document.hidden) renderer.setAnimationLoop(frame);
      }

      if (process.env.NODE_ENV !== "production") {
        // The phone budget for the live game is 60 draw calls. This is how that gets read.
        const debug = window as unknown as { vettaiRenderInfo?: () => THREE.WebGLInfo["render"] };
        debug.vettaiRenderInfo = () => renderer.info.render;
      }
    };

    // A hidden tab keeps its WebGL context but stops being drawn, which is the cheapest
    // thing the hero can do for a phone battery.
    const onVisibility = () => {
      const frame = frameRef.current;
      if (stopped || !frame) return;
      renderer.setAnimationLoop(document.hidden ? null : frame);
    };

    void start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      abort.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      renderer.setAnimationLoop(null);

      for (const drone of fleet) {
        scene.remove(drone);
        disposeDrone(drone);
      }
      disposeDrones();
      if (city && assets) disposeCity(city, assets);
      assets?.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [reduced]);

  return (
    <div ref={holder} className="absolute inset-0 overflow-hidden">
      {phase !== "running" && (
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 80% at 18% 8%, #1a2440 0%, #0f1526 38%, #0b0f1a 72%)",
          }}
        >
          {/* SWAP: poster still. A rendered frame of the city goes here for the browsers
              that cannot run WebGL, under the same scrim as the live canvas. */}
          <div
            className="absolute inset-x-0 bottom-0 h-1/2"
            style={{
              background:
                "linear-gradient(to top, rgba(255,106,43,0.16) 0%, transparent 70%)",
            }}
          />
        </div>
      )}

      <div className="pointer-events-none absolute bottom-6 right-6 z-10 text-right">
        {phase === "loading" && (
          <span className="label-type text-paper/45">loading the block {percent}%</span>
        )}
        {phase === "offline" && (
          <span className="label-type text-paper/45">city offline</span>
        )}
        {phase === "unsupported" && (
          <span className="label-type text-paper/45">still frame</span>
        )}
      </div>
    </div>
  );
}
