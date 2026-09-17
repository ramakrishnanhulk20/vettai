"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useReducedMotion } from "framer-motion";
import {
  fetchWorldMap,
  PATROL_Y,
  type Box,
  type Building,
  type Place,
  type WorldMap,
} from "@/game/map";
import { segmentHitsBox } from "@/game/slide";
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

/** How much room the camera keeps off a facade before a stretch of street is unusable. */
const CAMERA_CLEARANCE = 3;
/** The camera stays on the block a player lands on rather than the far edge of the map. */
const NEAR_OFFICE = 120;
/** Where down the street the first drone sits when the shot opens, in metres. */
const DRONE_LEAD = 14;
/** The length of the made-up street used when no patrol leg is usable. */
const FALLBACK_RUN = 60;
/**
 * Where in the run the shot opens. At zero the camera is stopped at the near end and
 * still swinging round, which spent the first seconds of the page looking at a facade.
 */
const START_PHASE = 0.07;
/** How long the opening frame is watched for drones, in seconds. */
const OPENING_WATCH = 3;

type Phase = "loading" | "running" | "offline" | "unsupported";

type HeroLeg = {
  axisAligned: boolean;
  clearOfBuildings: boolean;
  length: number;
  dronesInViewAt3s: number;
};

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

/** Every footprint grown by the camera's clearance, so a near miss counts as a hit. */
function clearanceBoxes(buildings: Building[]): Box[] {
  return buildings.map((building) => ({
    minX: building.aabb.minX - CAMERA_CLEARANCE,
    minZ: building.aabb.minZ - CAMERA_CLEARANCE,
    maxX: building.aabb.maxX + CAMERA_CLEARANCE,
    maxZ: building.aabb.maxZ + CAMERA_CLEARANCE,
  }));
}

/** Streets run along x or along z. Anything else is a diagonal across the lots. */
function runsWithTheStreet(from: Place, to: Place): boolean {
  return Math.abs(to.x - from.x) < 0.01 || Math.abs(to.z - from.z) < 0.01;
}

/**
 * The game's slab test with the height planes opened up, so only the footprint decides it.
 * The camera flies below every roof, so a tall building is never something to fly over.
 */
function clearOfBuildings(from: Place, to: Place, boxes: readonly Box[]): boolean {
  for (const box of boxes) {
    if (segmentHitsBox({ x: from.x, y: 0, z: from.z }, { x: to.x, y: 0, z: to.z }, box, -1, 1)) {
      return false;
    }
  }
  return true;
}

/** How close the office comes to the leg at the leg's nearest point. */
function rangeToOffice(from: Place, to: Place, office: Place): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const square = dx * dx + dz * dz;
  const along =
    square === 0
      ? 0
      : clamp(((office.x - from.x) * dx + (office.z - from.z) * dz) / square, 0, 1);
  return Math.hypot(from.x + along * dx - office.x, from.z + along * dz - office.z);
}

/**
 * The stretch the camera flies. Map version 3 moved patrol waypoints off the street grid,
 * which made the longest leg a diagonal straight through a block, so length alone is no
 * longer enough: a leg has to run down a street and miss every building, and of those the
 * longest one near the office wins, because that block is what a player lands on.
 */
function cameraLeg(loops: Place[][], office: Place, boxes: readonly Box[]): Leg | null {
  let best: Leg | null = null;
  let bestRange = Infinity;

  loops.forEach((loop, index) => {
    let travelled = 0;
    for (let step = 0; step < loop.length; step++) {
      const from = loop[step] as Place;
      const to = loop[(step + 1) % loop.length] as Place;
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      const at = travelled;
      travelled += length;

      if (length <= 0) continue;
      if (!runsWithTheStreet(from, to)) continue;
      if (!clearOfBuildings(from, to, boxes)) continue;

      const range = rangeToOffice(from, to, office);
      if (range > NEAR_OFFICE) continue;
      // Longest wins, and the closer street settles a tie, so every load opens the same way.
      const beaten =
        best !== null && (length < best.length || (length === best.length && range >= bestRange));
      if (beaten) continue;

      best = {
        loop,
        index,
        start: new THREE.Vector3(from.x, 0, from.z),
        forward: new THREE.Vector3((to.x - from.x) / length, 0, (to.z - from.z) / length),
        length,
        at,
      };
      bestRange = range;
    }
  });

  return best;
}

/** Nothing on the patrol grid qualified: the street in front of the office, checked the same way. */
function officeStreet(office: Place, boxes: readonly Box[]): Leg | null {
  const z = office.z - 4;
  const from = { x: office.x - FALLBACK_RUN / 2, z };
  const to = { x: office.x + FALLBACK_RUN / 2, z };
  if (!clearOfBuildings(from, to, boxes)) return null;
  return {
    loop: [],
    index: -1,
    start: new THREE.Vector3(from.x, 0, from.z),
    forward: new THREE.Vector3(1, 0, 0),
    length: FALLBACK_RUN,
    at: 0,
  };
}

/** How far round its loop each drone starts, in metres. */
function heads(count: number, loops: Place[][], leg: Leg | null, lead: number): number[] {
  const spread: number[] = [];
  for (let index = 0; index < count; index++) {
    const loop = index % loops.length;
    if (leg && leg.index >= 0 && loop === leg.index) {
      // Four drones share the camera's loop: the first one is already down the street in
      // front of the lens, the rest trail back so another arrives every half minute.
      const rank = Math.floor(index / loops.length);
      spread.push(lead - rank * 84);
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
      const boxes = clearanceBoxes(map.buildings);
      const leg = cameraLeg(loops, map.office, boxes) ?? officeStreet(map.office, boxes);
      const run = leg ? Math.min(leg.length - 8, RUN_LENGTH) : RUN_LENGTH;
      const forward = leg
        ? leg.forward.clone()
        : new THREE.Vector3(0, 0, 1);
      const from = leg
        ? leg.start.clone().addScaledVector(forward, (leg.length - run) / 2)
        : new THREE.Vector3(map.office.x, 0, map.office.z - run / 2);
      from.y = eyeHeight();
      const to = from.clone().addScaledVector(forward, run);
      const path = { from: { x: from.x, z: from.z }, to: { x: to.x, z: to.z } };
      const up = new THREE.Vector3(0, 1, 0);
      const heading = new THREE.Vector3();
      const cycle = (2 * run) / CAMERA_SPEED;
      const look = new THREE.Vector3();
      const shot = {
        axisAligned: runsWithTheStreet(path.from, path.to),
        clearOfBuildings: clearOfBuildings(path.from, path.to, boxes),
        length: run,
      };
      if (process.env.NODE_ENV !== "production") {
        console.info("hero camera leg", { loop: leg ? leg.index : -1, ...path, ...shot });
      }

      // The shot opens a little way into the run, already moving and already pointed down
      // the street, and the nearest drone is placed that far ahead of the lens, so the
      // first frame a visitor sees is a street with something flying down it.
      const opening = cycle * START_PHASE;
      const lead = leg
        ? leg.at +
          (leg.length - run) / 2 +
          smoothPingPong(START_PHASE) * run +
          DRONE_LEAD -
          opening * DRONE_SPEED
        : 0;

      const offsets = heads(DRONE_COUNT, loops, leg, lead);
      for (let index = 0; index < DRONE_COUNT && loops.length > 0; index++) {
        const drone = createDrone();
        drone.userData.loop = loops[index % loops.length];
        drone.userData.head = offsets[index] ?? index * 37;
        drone.userData.lift = PATROL_Y + (index % 3) * 0.6;
        scene.add(drone);
        fleet.push(drone);
      }

      const frustum = new THREE.Frustum();
      const viewProjection = new THREE.Matrix4();
      const watch =
        process.env.NODE_ENV === "production" ? null : { seen: 0, shown: 0, done: false };

      let last = performance.now();
      let elapsed = opening;

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
        // A phone sees about a third of the street the desktop does, so the same drift in
        // yaw would swing a facade across the whole frame.
        const drift = camera.aspect < 1 ? 0.06 : 0.16;
        const turn = ((1 - way) / 2) * Math.PI + Math.sin(elapsed * 0.11) * drift;
        heading.copy(forward).applyAxisAngle(up, turn);
        look.copy(camera.position).addScaledVector(heading, 24);
        // Portrait still looks up more than desktop, because the towers are what fills a
        // tall frame, but not so far up that the street itself leaves the shot.
        look.y = eye + (camera.aspect < 1 ? 1.8 : 1.2);
        camera.lookAt(look);

        for (const drone of fleet) {
          const loop = drone.userData.loop as Place[];
          const head = drone.userData.head as number;
          const lift = drone.userData.lift as number;
          flyPatrol(drone, loop, head + elapsed * DRONE_SPEED, lift);
          animateDrone(drone, elapsed, !reduced);
        }

        renderer.render(scene, camera);

        // A dev-only reading of the opening frame: whether the camera path runs down a
        // street clear of buildings, and how many drones were in the lens in the first
        // seconds. The browser check reads this rather than judging a screenshot.
        if (watch && !watch.done) {
          watch.shown += delta;
          viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
          frustum.setFromProjectionMatrix(viewProjection);
          let inFrame = 0;
          for (const drone of fleet) if (frustum.containsPoint(drone.position)) inFrame += 1;
          if (inFrame > watch.seen) watch.seen = inFrame;
          if (watch.shown >= OPENING_WATCH || reduced) {
            watch.done = true;
            const reading = window as unknown as { vettaiHeroLeg?: HeroLeg };
            reading.vettaiHeroLeg = { ...shot, dronesInViewAt3s: watch.seen };
          }
        }
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
