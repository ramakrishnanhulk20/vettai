"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useReducedMotion } from "framer-motion";
import { createCameraRig, type Blocker } from "@/game/camera";
import { fetchWorldMap, PATROL_Y, type Place, type WorldMap } from "@/game/map";
import { loadCityAssets, type CityAssets } from "@/game/scene/assets";
import { createAtmosphere, type Atmosphere } from "@/game/scene/atmosphere";
import {
  createCharacter,
  disposeCharacters,
  loadCharacters,
  type Character,
} from "@/game/scene/character";
import { animateCity, buildCity, disposeCity, lampSpots } from "@/game/scene/city";
import {
  animateDrone,
  createDrone,
  disposeDrone,
  disposeDrones,
  flyPatrol,
} from "@/game/scene/drone";
import { addLampGlow, addNightLights } from "@/game/scene/lights";
import { tuneRenderer, type Look } from "@/game/scene/materials";
import { scenePixelRatio } from "@/game/scene/pixelRatio";
import { createNeon, type Neon } from "@/game/scene/neon";

/**
 * The look test. The same block, built twice, so the two can be put next to each other
 * on one screen and judged rather than described. Everything on this page reads the live
 * world map, exactly as the game does.
 */

const WALK_FROM = 6;
const WALK_TO = 54;
const WALK_SPEED = 2.3;
const STREET_Z = 4;

/** How long the automatic shot spends orbiting before it walks the street. */
const ORBIT_SECONDS = 22;
const WALK_SECONDS = 20;

const DRONE_COUNT = 2;
const DRONE_SPEED = 3;

type Shot = "auto" | "player";
type Phase = "loading" | "running" | "offline" | "unsupported";

type Readout = { calls: number; triangles: number; fps: number };

function webglWorks(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

/** The loop that passes closest to the office, so both drones stay in the shot. */
function nearestLoop(map: WorldMap): Place[] {
  let best: Place[] = map.patrols[0] ?? [];
  let bestRange = Infinity;
  for (const loop of map.patrols) {
    for (const spot of loop) {
      const range = Math.hypot(spot.x - map.office.x, spot.z - map.office.z);
      if (range < bestRange) {
        bestRange = range;
        best = loop;
      }
    }
  }
  return best;
}

export default function CityLook() {
  const holder = useRef<HTMLDivElement>(null);
  const [look, setLook] = useState<Look>("v2");
  const [phase, setPhase] = useState<Phase>("loading");
  const [percent, setPercent] = useState(0);
  const [readout, setReadout] = useState<Readout>({ calls: 0, triangles: 0, fps: 0 });
  const shot = useRef<Shot>("auto");
  const [shotName, setShotName] = useState<Shot>("auto");
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
    let sky: Atmosphere | null = null;
    let neon: Neon | null = null;
    let walker: Character | null = null;
    const fleet: THREE.Group[] = [];
    const abort = new AbortController();

    setPhase("loading");
    setPercent(0);

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
    tuneRenderer(renderer, look);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 1, 0.2, 520);
    const rig = createCameraRig();
    const lampGlow = addLampGlow(scene);

    const redraw: { current: (() => void) | null } = { current: null };

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      renderer.setPixelRatio(scenePixelRatio());
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.fov = camera.aspect < 1 ? 68 : 58;
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
          if (!stopped) setPercent(Math.round((done / total) * 90));
        }, look);
        await loadCharacters();
      } catch {
        if (!stopped) setPhase("offline");
        return;
      }
      if (stopped || !assets) return;
      setPercent(100);

      addNightLights(scene, map.size, look);
      city = buildCity(map, assets, look);
      scene.add(city);

      if (look === "v2") {
        sky = createAtmosphere(map);
        scene.add(sky.group);
        neon = createNeon(map);
        scene.add(neon.group);
      }

      walker = createCharacter("neon", look);
      scene.add(walker.group);

      const loop = nearestLoop(map);
      for (let index = 0; index < DRONE_COUNT && loop.length > 1; index += 1) {
        const drone = createDrone(look);
        drone.userData.head = index * 46;
        drone.userData.lift = PATROL_Y + index * 1.1;
        scene.add(drone);
        fleet.push(drone);
      }

      const spots = lampSpots(map);
      const blockers: Blocker[] = map.buildings.map((building) => ({
        aabb: building.aabb,
        height: building.height,
      }));

      const focus = new THREE.Vector3();
      const look3 = new THREE.Vector3();
      const frames: number[] = [];
      const span = WALK_TO - WALK_FROM;
      const cycle = (2 * span) / WALK_SPEED;
      const shotCycle = ORBIT_SECONDS + WALK_SECONDS;

      let last = performance.now();
      let elapsed = 0;
      let published = 0;

      const frame = () => {
        const now = performance.now();
        const delta = Math.min((now - last) / 1000, 0.05);
        last = now;
        if (!reduced) elapsed += delta;

        // The body walks the street between the office and the shop and turns round at
        // each end, so every shot has something alive in it.
        const along = (elapsed % cycle) * WALK_SPEED;
        const outward = along <= span;
        const at = WALK_FROM + (outward ? along : 2 * span - along);
        const yaw = outward ? Math.PI / 2 : -Math.PI / 2;
        if (walker) {
          walker.group.position.set(at, 0, STREET_Z);
          walker.group.rotation.set(0, yaw, 0);
          walker.setMoving(reduced ? 0 : WALK_SPEED);
          walker.update(delta);
        }
        focus.set(at, 0, STREET_Z);

        if (shot.current === "player") {
          rig.update(camera, { x: at, z: STREET_Z }, yaw, 0, blockers, delta);
        } else if (elapsed % shotCycle < ORBIT_SECONDS) {
          // A slow ring at eye height. The camera never gets above a player's head, so
          // what Ram is judging is what a player would actually see.
          const turn = elapsed * 0.13;
          const portrait = camera.aspect < 1;
          const radius = (portrait ? 15 : 9.5) + Math.sin(elapsed * 0.21) * 2.4;
          camera.position.set(
            at + Math.cos(turn) * radius,
            1.9 + Math.sin(elapsed * 0.17) * 0.5,
            STREET_Z + Math.sin(turn) * radius,
          );
          look3.set(at, portrait ? 3.4 : 1.6, STREET_Z);
          camera.lookAt(look3);
        } else {
          // A tracking shot down the street, a few paces behind the body, at the height
          // a player's eyes are. Held off the centre line so the road and the pavement
          // both stay in frame, and never close enough to a facade to eat the shot.
          const trail = outward ? -7.5 : 7.5;
          const lead = outward ? 9 : -9;
          camera.position.set(at + trail, 1.75, STREET_Z - 1);
          look3.set(at + lead, camera.aspect < 1 ? 3.4 : 2.2, STREET_Z + 0.8);
          camera.lookAt(look3);
        }

        lampGlow.update(spots, camera.position.x, camera.position.z);
        animateCity(city as THREE.Group, elapsed);
        neon?.update(elapsed);
        sky?.update(elapsed, camera.position);

        for (const drone of fleet) {
          const head = drone.userData.head as number;
          const lift = drone.userData.lift as number;
          flyPatrol(drone, loop, head + elapsed * DRONE_SPEED, lift);
          animateDrone(drone, elapsed, !reduced);
        }

        renderer.render(scene, camera);

        while (frames.length > 0 && now - (frames[0] as number) > 1000) frames.shift();
        frames.push(now);
        if (now - published > 250) {
          published = now;
          setReadout({
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            fps: frames.length,
          });
        }
      };

      if (stopped) return;
      redraw.current = frame;
      setPhase("running");

      if (reduced) {
        frame();
      } else {
        frameRef.current = frame;
        if (!document.hidden) renderer.setAnimationLoop(frame);
      }

      // The same hook the hero exposes, so the numbers in the readout can be checked
      // from outside the page.
      const debug = window as unknown as { vettaiRenderInfo?: () => THREE.WebGLInfo["render"] };
      debug.vettaiRenderInfo = () => renderer.info.render;
    };

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
      walker?.dispose();
      disposeCharacters();
      neon?.dispose();
      sky?.dispose();
      lampGlow.dispose();
      if (city && assets) disposeCity(city, assets);
      assets?.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [look, reduced]);

  const pickShot = (next: Shot) => {
    shot.current = next;
    setShotName(next);
  };

  return (
    <div className="absolute inset-0 overflow-hidden bg-night">
      <div ref={holder} className="absolute inset-0" />

      {/* The corners of a lens, faked in CSS. It costs nothing and it is the difference
          between a render and a shot. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-20"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 45%, transparent 38%, rgba(4,6,12,0.55) 88%, rgba(3,4,9,0.82) 100%)",
        }}
      />

      <div className="absolute left-5 top-5 z-30 flex flex-col gap-3 sm:left-8 sm:top-8">
        <div className="flex items-center gap-2">
          <span className="label-type text-paper/40">look:</span>
          {(["v1", "v2"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setLook(option)}
              className={`label-type rounded-[8px] border px-3 py-1.5 transition-colors duration-200 ${
                look === option
                  ? "border-hunt/70 bg-hunt/15 text-hunt"
                  : "border-line text-paper/50 hover:border-paper/40 hover:text-paper"
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="label-type text-paper/40">shot:</span>
          {(
            [
              ["auto", "auto"],
              ["player", "player view"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => pickShot(value)}
              className={`label-type rounded-[8px] border px-3 py-1.5 transition-colors duration-200 ${
                shotName === value
                  ? "border-paper/60 bg-paper/10 text-paper"
                  : "border-line text-paper/50 hover:border-paper/40 hover:text-paper"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Clear of the dev server badge, which sits in this corner on localhost. */}
      <div className="pointer-events-none absolute bottom-20 left-5 z-30 sm:left-8">
        <div className="label-type flex flex-col gap-1 text-paper/55">
          <span>
            draw calls <span className="text-paper">{readout.calls}</span>
          </span>
          <span>
            triangles <span className="text-paper">{readout.triangles.toLocaleString()}</span>
          </span>
          <span>
            fps <span className="text-paper">{readout.fps}</span>
          </span>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-5 right-5 z-30 text-right sm:bottom-8 sm:right-8">
        {phase === "loading" && (
          <span className="label-type text-paper/45">building the block {percent}%</span>
        )}
        {phase === "offline" && <span className="label-type text-paper/45">city offline</span>}
        {phase === "unsupported" && <span className="label-type text-paper/45">no webgl here</span>}
        {phase === "running" && (
          <span className="label-type text-paper/30">vettai look test</span>
        )}
      </div>
    </div>
  );
}
