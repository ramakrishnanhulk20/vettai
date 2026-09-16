import * as THREE from "three";
import type { BoltWire, DroneWire, PlayerWire, StateFrame, TickEvent, WelcomeFrame } from "@/lib/ws";
import type { Gear } from "@/lib/api";
import { createCameraRig, type Blocker } from "./camera";
import type { Box, WorldMap } from "./map";
import { rayConeNearest, slideAgainstBoxes } from "./slide";
import type { CityAssets } from "./scene/assets";
import { buildCity, disposeCity } from "./scene/city";
import { createCharacter, type Character } from "./scene/character";
import { animateDrone, createDrone, disposeDrone, disposeDrones } from "./scene/drone";
import { addNightLights, NIGHT } from "./scene/lights";
import { scenePixelRatio } from "./scene/pixelRatio";

/**
 * The world as the phone draws it.
 *
 * The server is the authority, so everything here is a reading of frames that already
 * happened: other players and the drones are drawn 100 ms behind the clock, between the
 * last two positions the server sent, which is what makes them glide instead of stutter.
 * The player's own body is the exception. It is stepped from the thumb at the speed the
 * server uses, with the same wall sliding, and pulled back toward the server's answer
 * every frame, so walking feels instant and still ends up where the server says.
 */

/** How far behind the newest frame everything remote is drawn. Two ticks of headroom. */
const INTERPOLATION_MS = 100;

const PLAYER_RADIUS = 0.5;
const WALK_SPEED = 6;
const SPRINT_SPEED = 7;
const EYE_HEIGHT = 1.6;

/** Share of the gap to the server's position closed each frame. */
const RECONCILE = 0.2;

/** Further out than this and the walk is a lost cause: the body is put where the server says. */
const SNAP_METRES = 3;

/** The aim assist cone on the server, drawn here only to tell the player it is on them. */
const AIM_CONE = (6 * Math.PI) / 180;
const HITSCAN_RANGE = 60;

const INTERACT_RANGE = 2.4;

const BOLT_RADIUS = 0.16;
const SPARKS = 12;
const SPARK_LIFE = 0.7;
const WRECK_FALL = 0.9;
const HIT_FLASH_MS = 140;

const ACCENT = 0xff6a2b;

export type Place = { x: number; z: number };

export type Prompt =
  | { kind: "office" }
  | { kind: "shop" }
  | { kind: "landmark"; index: number }
  | { kind: "courier"; point: number };

export type WorldEvent =
  | { kind: "kill" }
  | { kind: "downed" }
  | { kind: "respawn" }
  | { kind: "shieldHit"; shield: number };

export type WorldOptions = {
  canvas: HTMLCanvasElement;
  map: WorldMap;
  assets: CityAssets;
  you: string;
  reduced: boolean;
  readIntent: () => { dx: number; dz: number; yaw: number };
  readLook: () => { yaw: number; pitch: number };
  /** Fires only when the answer changes, so the HUD never re-renders per frame. */
  onAim: (hot: boolean) => void;
  onPrompt: (prompt: Prompt | null) => void;
  onShield: (shield: number) => void;
  onEvent: (event: WorldEvent) => void;
};

export type World = {
  welcome: (frame: WelcomeFrame) => void;
  state: (frame: StateFrame) => void;
  leave: (playerId: string) => void;
  setGear: (gear: Gear) => void;
  /** Draws one frame. `now` is a performance clock reading in milliseconds. */
  frame: (now: number) => void;
  resize: () => void;
  /** Called when the page comes back from hidden, so one long gap is not stepped through. */
  resume: (now: number) => void;
  place: () => Place;
  /** What the last frame cost, for the performance check on a phone. */
  stats: () => { calls: number; triangles: number };
  dispose: () => void;
};

type Sample = { t: number; x: number; y: number; z: number; yaw: number };

type Track = { samples: Sample[] };

type RemotePlayer = {
  wire: PlayerWire;
  track: Track;
  character: Character;
  lastPlace: Place;
};

type DroneView = {
  group: THREE.Group;
  track: Track;
  hp: number;
  flashUntil: number;
};

type Wreck = { group: THREE.Group; started: number; fromY: number };

type Spark = { points: THREE.Points; started: number; velocities: Float32Array };

function pushSample(track: Track, sample: Sample): void {
  const samples = track.samples;
  samples.push(sample);
  if (samples.length > 8) samples.shift();
}

/** The position at a moment in the past, between the two samples that bracket it. */
function readTrack(track: Track, at: number): Sample | null {
  const samples = track.samples;
  if (samples.length === 0) return null;

  const newest = samples[samples.length - 1] as Sample;
  if (samples.length === 1 || at >= newest.t) return newest;

  for (let index = samples.length - 1; index > 0; index--) {
    const after = samples[index] as Sample;
    const before = samples[index - 1] as Sample;
    if (at >= before.t) {
      const span = after.t - before.t;
      const ratio = span > 0 ? (at - before.t) / span : 1;
      let turn = after.yaw - before.yaw;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      return {
        t: at,
        x: before.x + (after.x - before.x) * ratio,
        y: before.y + (after.y - before.y) * ratio,
        z: before.z + (after.z - before.z) * ratio,
        yaw: before.yaw + turn * ratio,
      };
    }
  }
  return samples[0] as Sample;
}

export function createWorld(options: WorldOptions): World {
  const { canvas, map, assets, you, reduced } = options;

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
  addNightLights(scene, map.size);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.2, 520);
  const rig = createCameraRig();

  const city = buildCity(map, assets);
  scene.add(city);

  const boxes: Box[] = map.buildings.map((building) => building.aabb);
  const blockers: Blocker[] = map.buildings.map((building) => ({
    aabb: building.aabb,
    height: building.height,
  }));
  const limit = map.size / 2 - PLAYER_RADIUS;

  const boltGeometry = new THREE.SphereGeometry(BOLT_RADIUS, 6, 5);
  const boltMaterial = new THREE.MeshBasicMaterial({ color: 0xff8a4c, toneMapped: false });
  const sparkMaterial = new THREE.PointsMaterial({
    color: 0xffc27a,
    size: 0.32,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const players = new Map<string, RemotePlayer>();
  const drones = new Map<string, DroneView>();
  const bolts = new Map<string, { mesh: THREE.Mesh; track: Track; seenAt: number }>();
  const wrecks: Wreck[] = [];
  const sparks: Spark[] = [];

  let me: Character | null = null;
  let marker: THREE.Mesh | null = null;
  let gear: Gear = { blaster: "mk1", skin: "default", sprint: false };
  let predicted: Place = { x: map.spawn.x, z: map.spawn.z };
  let serverPlace: Place = { x: map.spawn.x, z: map.spawn.z };
  let shield = 3;
  let downed = false;
  let lastFrameAt = 0;
  let aimHot = false;
  let promptNow: Prompt | null = null;

  function characterFor(skin: string): Character {
    const character = createCharacter(skin);
    scene.add(character.group);
    return character;
  }

  function dropPlayer(entry: RemotePlayer): void {
    scene.remove(entry.character.group);
    entry.character.dispose();
  }

  function trackPlayer(wire: PlayerWire, at: number): void {
    if (wire.id === you) {
      serverPlace = { x: wire.x, z: wire.z };
      if (wire.shield !== shield) {
        const hurt = wire.shield < shield;
        shield = wire.shield;
        options.onShield(shield);
        if (hurt) options.onEvent({ kind: "shieldHit", shield });
      }
      if (wire.downed !== downed) {
        downed = wire.downed;
        if (downed) options.onEvent({ kind: "downed" });
      }
      if (!me) me = characterFor(wire.gear.skin);
      gear = wire.gear;
      return;
    }

    const known = players.get(wire.id);
    if (!known) {
      const entry: RemotePlayer = {
        wire,
        track: { samples: [] },
        character: characterFor(wire.gear.skin),
        lastPlace: { x: wire.x, z: wire.z },
      };
      pushSample(entry.track, { t: at, x: wire.x, y: 0, z: wire.z, yaw: wire.yaw });
      players.set(wire.id, entry);
      return;
    }

    if (known.wire.gear.skin !== wire.gear.skin) {
      dropPlayer(known);
      known.character = characterFor(wire.gear.skin);
    }
    known.wire = wire;
    pushSample(known.track, { t: at, x: wire.x, y: 0, z: wire.z, yaw: wire.yaw });
  }

  function trackDrone(wire: DroneWire, at: number): void {
    const known = drones.get(wire.id);
    if (!known) {
      const group = createDrone();
      group.position.set(wire.x, wire.y, wire.z);
      scene.add(group);
      const view: DroneView = { group, track: { samples: [] }, hp: wire.hp, flashUntil: 0 };
      pushSample(view.track, { t: at, x: wire.x, y: wire.y, z: wire.z, yaw: wire.yaw });
      drones.set(wire.id, view);
      return;
    }
    known.hp = wire.hp;
    pushSample(known.track, { t: at, x: wire.x, y: wire.y, z: wire.z, yaw: wire.yaw });
  }

  function trackBolt(wire: BoltWire, at: number): void {
    const known = bolts.get(wire.id);
    if (!known) {
      const mesh = new THREE.Mesh(boltGeometry, boltMaterial);
      mesh.position.set(wire.x, wire.y, wire.z);
      scene.add(mesh);
      const view = { mesh, track: { samples: [] }, seenAt: at };
      pushSample(view.track, { t: at, x: wire.x, y: wire.y, z: wire.z, yaw: 0 });
      bolts.set(wire.id, view);
      return;
    }
    known.seenAt = at;
    pushSample(known.track, { t: at, x: wire.x, y: wire.y, z: wire.z, yaw: 0 });
  }

  function burst(x: number, y: number, z: number, now: number): void {
    if (reduced) return;

    const positions = new Float32Array(SPARKS * 3);
    const velocities = new Float32Array(SPARKS * 3);
    for (let index = 0; index < SPARKS; index++) {
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      const angle = (index / SPARKS) * Math.PI * 2;
      const lift = 1.4 + (index % 3) * 0.8;
      velocities[index * 3] = Math.cos(angle) * 3.4;
      velocities[index * 3 + 1] = lift;
      velocities[index * 3 + 2] = Math.sin(angle) * 3.4;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, sparkMaterial.clone());
    points.frustumCulled = false;
    scene.add(points);
    sparks.push({ points, started: now, velocities });
  }

  function killDrone(id: string, at: THREE.Vector3, now: number): void {
    const view = drones.get(id);
    if (view) {
      drones.delete(id);
      wrecks.push({ group: view.group, started: now, fromY: view.group.position.y });
    }
    burst(at.x, at.y, at.z, now);
  }

  function handleEvent(event: TickEvent, now: number): void {
    if (event.kind === "hit" || event.kind === "droneHit") {
      const view = event.kind === "hit" ? drones.get(event.drone) : null;
      if (view) view.flashUntil = now + HIT_FLASH_MS;
      return;
    }
    if (event.kind === "kill") {
      killDrone(event.drone, new THREE.Vector3(event.x, event.y, event.z), now);
      if (event.player === you) options.onEvent({ kind: "kill" });
      return;
    }
    if (event.kind === "respawn" && event.player === you) {
      predicted = { x: event.x, z: event.z };
      serverPlace = { x: event.x, z: event.z };
      rig.snap();
      options.onEvent({ kind: "respawn" });
    }
  }

  /** The nearest place the player could tap, or nothing when they are not standing on one. */
  function nearestPlace(): Prompt | null {
    const candidates: [Prompt, Place][] = [
      [{ kind: "office" }, map.office],
      [{ kind: "shop" }, map.shop],
      ...map.landmarks.map((landmark, index): [Prompt, Place] => [
        { kind: "landmark", index },
        landmark,
      ]),
      ...map.courier.map((point, index): [Prompt, Place] => [{ kind: "courier", point: index }, point]),
    ];

    let found: Prompt | null = null;
    let closest = INTERACT_RANGE;
    for (const [prompt, place] of candidates) {
      const range = Math.hypot(place.x - predicted.x, place.z - predicted.z);
      if (range > closest) continue;
      closest = range;
      found = prompt;
    }
    return found;
  }

  function samePrompt(a: Prompt | null, b: Prompt | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.kind !== b.kind) return false;
    if (a.kind === "landmark" && b.kind === "landmark") return a.index === b.index;
    if (a.kind === "courier" && b.kind === "courier") return a.point === b.point;
    return true;
  }

  function stepLocal(dt: number, look: { yaw: number; pitch: number }): number {
    const intent = options.readIntent();
    const speed = gear.sprint ? SPRINT_SPEED : WALK_SPEED;
    let travelled = 0;

    if (!downed && (intent.dx !== 0 || intent.dz !== 0)) {
      const clamp = (value: number) => (value < -limit ? -limit : value > limit ? limit : value);
      const wanted = {
        x: clamp(predicted.x + intent.dx * speed * dt),
        z: clamp(predicted.z + intent.dz * speed * dt),
      };
      const moved = slideAgainstBoxes(predicted, wanted, PLAYER_RADIUS, boxes);
      travelled = Math.hypot(moved.x - predicted.x, moved.z - predicted.z);
      predicted = moved;
    }

    const drift = Math.hypot(serverPlace.x - predicted.x, serverPlace.z - predicted.z);
    if (drift > SNAP_METRES) {
      predicted = { x: serverPlace.x, z: serverPlace.z };
    } else if (drift > 0.001) {
      predicted = {
        x: predicted.x + (serverPlace.x - predicted.x) * RECONCILE,
        z: predicted.z + (serverPlace.z - predicted.z) * RECONCILE,
      };
    }

    if (me) {
      me.group.position.set(predicted.x, 0, predicted.z);
      me.group.rotation.y = look.yaw;
      me.setMoving(dt > 0 ? travelled / dt : 0);
      me.update(dt);
    }
    if (marker) marker.position.set(predicted.x, 0.03, predicted.z);

    return travelled;
  }

  /** True when a live drone is inside the same cone the server would count as a hit. */
  function aimingAtDrone(look: { yaw: number; pitch: number }): boolean {
    const flat = Math.cos(look.pitch);
    const dir = {
      x: Math.sin(look.yaw) * flat,
      y: Math.sin(look.pitch),
      z: Math.cos(look.yaw) * flat,
    };
    const eye = { x: predicted.x, y: EYE_HEIGHT, z: predicted.z };
    const targets: { x: number; y: number; z: number }[] = [];
    for (const drone of drones.values()) {
      const at = drone.group.position;
      targets.push({ x: at.x, y: at.y, z: at.z });
    }
    return rayConeNearest(eye, dir, AIM_CONE, HITSCAN_RANGE, targets) !== null;
  }

  function drawRemotes(renderAt: number, dt: number, now: number): void {
    for (const entry of players.values()) {
      const sample = readTrack(entry.track, renderAt);
      if (!sample) continue;
      const group = entry.character.group;
      const speed = dt > 0 ? Math.hypot(sample.x - entry.lastPlace.x, sample.z - entry.lastPlace.z) / dt : 0;
      entry.lastPlace = { x: sample.x, z: sample.z };
      group.position.set(sample.x, 0, sample.z);
      group.rotation.y = sample.yaw;
      group.visible = !entry.wire.downed;
      entry.character.setMoving(speed);
      entry.character.update(dt);
    }

    const elapsed = now / 1000;
    for (const drone of drones.values()) {
      const sample = readTrack(drone.track, renderAt);
      if (sample) {
        drone.group.position.set(sample.x, sample.y, sample.z);
        drone.group.rotation.y = sample.yaw;
      }
      animateDrone(drone.group, elapsed, !reduced);
      const flashing = now < drone.flashUntil;
      drone.group.scale.setScalar(flashing ? 1.25 : 1);
    }

    for (const [id, bolt] of bolts) {
      if (now - bolt.seenAt > 250) {
        scene.remove(bolt.mesh);
        bolts.delete(id);
        continue;
      }
      const sample = readTrack(bolt.track, renderAt);
      if (sample) bolt.mesh.position.set(sample.x, sample.y, sample.z);
    }

    for (let index = wrecks.length - 1; index >= 0; index--) {
      const wreck = wrecks[index] as Wreck;
      const age = (now - wreck.started) / 1000;
      if (age >= WRECK_FALL) {
        scene.remove(wreck.group);
        disposeDrone(wreck.group);
        wrecks.splice(index, 1);
        continue;
      }
      const fall = age / WRECK_FALL;
      wreck.group.position.y = wreck.fromY * (1 - fall * fall);
      wreck.group.rotation.z = fall * 1.9;
      wreck.group.rotation.x = fall * 0.8;
    }

    for (let index = sparks.length - 1; index >= 0; index--) {
      const spark = sparks[index] as Spark;
      const age = (now - spark.started) / 1000;
      if (age >= SPARK_LIFE) {
        scene.remove(spark.points);
        spark.points.geometry.dispose();
        (spark.points.material as THREE.PointsMaterial).dispose();
        sparks.splice(index, 1);
        continue;
      }
      const attribute = spark.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      for (let n = 0; n < SPARKS; n++) {
        array[n * 3] += spark.velocities[n * 3] * dt;
        array[n * 3 + 1] += (spark.velocities[n * 3 + 1] - 9.8 * age) * dt;
        array[n * 3 + 2] += spark.velocities[n * 3 + 2] * dt;
      }
      attribute.needsUpdate = true;
      (spark.points.material as THREE.PointsMaterial).opacity = 1 - age / SPARK_LIFE;
    }
  }

  function resize(): void {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(scenePixelRatio());
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    // Three measures the field of view vertically, so a portrait phone would otherwise
    // trade the street for a band of empty sky.
    camera.fov = camera.aspect < 1 ? 70 : 58;
    camera.updateProjectionMatrix();
  }

  resize();

  return {
    welcome(frame) {
      const at = performance.now();
      for (const [id, entry] of players) {
        dropPlayer(entry);
        players.delete(id);
      }
      for (const wire of frame.players) trackPlayer(wire, at);
      for (const wire of frame.drones) trackDrone(wire, at);

      const mine = frame.players.find((wire) => wire.id === you);
      if (mine) {
        predicted = { x: mine.x, z: mine.z };
        serverPlace = { x: mine.x, z: mine.z };
        gear = mine.gear;
        shield = mine.shield;
        options.onShield(shield);
      }
      if (!marker) {
        marker = new THREE.Mesh(
          new THREE.RingGeometry(0.52, 0.62, 24).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({
            color: ACCENT,
            transparent: true,
            opacity: 0.55,
            toneMapped: false,
          }),
        );
        scene.add(marker);
      }
      rig.snap();
    },

    state(frame) {
      const at = performance.now();
      for (const wire of frame.players) trackPlayer(wire, at);

      const live = new Set<string>();
      for (const wire of frame.drones) {
        live.add(wire.id);
        trackDrone(wire, at);
      }
      for (const [id, view] of drones) {
        if (live.has(id)) continue;
        scene.remove(view.group);
        disposeDrone(view.group);
        drones.delete(id);
      }

      for (const wire of frame.bolts) trackBolt(wire, at);
      for (const event of frame.events) handleEvent(event, at);
    },

    leave(playerId) {
      const entry = players.get(playerId);
      if (!entry) return;
      dropPlayer(entry);
      players.delete(playerId);
    },

    setGear(next) {
      gear = next;
    },

    frame(now) {
      const dt = lastFrameAt === 0 ? 0.016 : Math.min(0.1, (now - lastFrameAt) / 1000);
      lastFrameAt = now;

      const look = options.readLook();
      stepLocal(dt, look);
      drawRemotes(now - INTERPOLATION_MS, dt, now);

      rig.update(camera, predicted, look.yaw, look.pitch, blockers, dt);

      const hot = aimingAtDrone(look);
      if (hot !== aimHot) {
        aimHot = hot;
        options.onAim(hot);
      }

      const near = nearestPlace();
      if (!samePrompt(near, promptNow)) {
        promptNow = near;
        options.onPrompt(near);
      }

      renderer.render(scene, camera);
    },

    resume(now) {
      lastFrameAt = now;
    },

    resize,

    place: () => ({ x: predicted.x, z: predicted.z }),

    stats: () => ({
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),

    dispose() {
      for (const [, entry] of players) dropPlayer(entry);
      players.clear();
      for (const [, view] of drones) {
        scene.remove(view.group);
        disposeDrone(view.group);
      }
      drones.clear();
      for (const wreck of wrecks) {
        scene.remove(wreck.group);
        disposeDrone(wreck.group);
      }
      wrecks.length = 0;
      for (const spark of sparks) {
        scene.remove(spark.points);
        spark.points.geometry.dispose();
        (spark.points.material as THREE.PointsMaterial).dispose();
      }
      sparks.length = 0;
      for (const [, bolt] of bolts) scene.remove(bolt.mesh);
      bolts.clear();
      if (me) {
        scene.remove(me.group);
        me.dispose();
        me = null;
      }
      if (marker) {
        scene.remove(marker);
        marker.geometry.dispose();
        (marker.material as THREE.Material).dispose();
        marker = null;
      }
      disposeDrones();
      disposeCity(city, assets);
      scene.remove(city);
      boltGeometry.dispose();
      boltMaterial.dispose();
      sparkMaterial.dispose();
      renderer.dispose();
    },
  };
}
