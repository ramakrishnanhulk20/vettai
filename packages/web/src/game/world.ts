import * as THREE from "three";
import type { BoltWire, DroneWire, PlayerWire, StateFrame, TickEvent, WelcomeFrame } from "@/lib/ws";
import type { Gear } from "@/lib/api";
import { createCameraRig, type Blocker } from "./camera";
import type { Box, WorldMap } from "./map";
import { segmentHitsBox, slideAgainstBoxes } from "./slide";
import type { SentMove } from "./controls";
import type { CityAssets } from "./scene/assets";
import { buildCity, disposeCity, lampSpots } from "./scene/city";
import { createCharacter, type Character } from "./scene/character";
import { animateDrone, createDrone, disposeDrone, disposeDrones } from "./scene/drone";
import { addLampGlow, addNightLights, NIGHT } from "./scene/lights";
import { scenePixelRatio } from "./scene/pixelRatio";

/**
 * The world as the phone draws it.
 *
 * The server is the authority, so everything here is a reading of frames that already
 * happened: other players and the drones are drawn 100 ms behind the clock, between the
 * last two positions the server sent, which is what makes them glide instead of stutter.
 *
 * The player's own body is the exception, and at half a second of round trip it is the
 * whole game. Every move intent that goes out is kept with the time it covered. When a
 * frame comes back the server position is taken as truth, the intents the server has
 * already applied are dropped, and the rest are replayed from that position with the
 * same speed and the same wall sliding. The drawn body eases onto that answer instead of
 * onto the raw server position, which is what stops the walk pulling backwards: the
 * server's answer is half a second old, the replayed one is now.
 */

/** How far behind the newest frame everything remote is drawn. Two ticks of headroom. */
const INTERPOLATION_MS = 100;

const PLAYER_RADIUS = 0.5;
const WALK_SPEED = 6;
const SPRINT_SPEED = 7;
const EYE_HEIGHT = 1.6;

/** Share of the gap to the replayed position closed each frame. */
const SMOOTHING = 0.3;

/**
 * The server applies an intent on its next tick and reports on a tick, so its answer for
 * "now" swings by up to two ticks of walking however good the replay is. Chasing that
 * swing is itself a pull-back, so a gap this small is left alone and only what is beyond
 * it, a wall or a rule the client got wrong, moves the body.
 */
const JITTER_METRES = 0.4;

/**
 * The most the body is moved by a correction in one frame. A walk step is about a tenth
 * of a metre, so anything under this cannot be seen as a jump: a real disagreement is
 * walked off over a few frames instead of snatched back in one.
 */
const CORRECTION_CAP = 0.15;

/** Further out than this and the walk is a lost cause: the body is put where the replay says. */
const SNAP_METRES = 2;

/** A replayed intent is walked in steps no longer than this, as the server's tick does. */
const STEP_CAP = 0.1;

/** More than a couple of seconds of unapplied intents means the socket is gone anyway. */
const PENDING_MAX = 64;

/**
 * How far off the camera a drone may sit and still be the one a tap shoots. The server
 * counts a 12 degree cone; a thumb on a moving phone cannot hold even that, so the client
 * points the shot at the drone and the server gets an aim it will accept.
 */
const ASSIST_CONE = (20 * Math.PI) / 180;
const HITSCAN_RANGE = 60;

/** Milliseconds between shots the simulation accepts, mirrored here for the local tracer. */
const FIRE_EVERY_MS: Record<string, number> = { mk1: 250, mk2: 167 };

const TRACER_MS = 80;
const MUZZLE_FORWARD = 0.8;
const MUZZLE_SIDE = 0.55;
const MUZZLE_HEIGHT = 1.05;

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
  /** Keeps a move intent that has just gone out, so the reply can be replayed against it. */
  noteMove: (move: SentMove) => void;
  /**
   * Draws the shot on this phone at once and answers with the aim to send: the drone the
   * player is pointing near, or the camera's own aim when there is none.
   */
  fire: (yaw: number, pitch: number) => { yaw: number; pitch: number };
  /** Draws one frame. `now` is a performance clock reading in milliseconds. */
  frame: (now: number) => void;
  resize: () => void;
  /** Called when the page comes back from hidden, so one long gap is not stepped through. */
  resume: (now: number) => void;
  place: () => Place;
  /**
   * What the last frame cost, for the performance check on a phone, and how far the last
   * frames had to move the body to agree with the server, which is the number that says
   * whether the walk is pulling backwards.
   */
  stats: () => {
    calls: number;
    triangles: number;
    correction: number;
    maxCorrection: number;
  };
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

/** A drone the thumb is near enough to, with the aim that points straight at it. */
type Shot = { yaw: number; pitch: number; at: THREE.Vector3; distance: number };

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

  const lamps = lampSpots(map);
  const lampGlow = addLampGlow(scene);

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

  // One beam and one spark of light, reused for every shot: a tracer allocated per trigger
  // pull would have the garbage collector running during a firefight. A drawn line would
  // be one pixel wide whatever the screen, which is nothing at arm's length on a phone,
  // so the tracer is a thin tapered tube that is scaled to the shot.
  const tracerGeometry = new THREE.CylinderGeometry(0.02, 0.06, 1, 6, 1, true);
  tracerGeometry.translate(0, 0.5, 0);
  const tracerMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc27a,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const tracer = new THREE.Mesh(tracerGeometry, tracerMaterial);
  tracer.frustumCulled = false;
  tracer.visible = false;
  scene.add(tracer);

  const muzzleGeometry = new THREE.SphereGeometry(0.2, 8, 6);
  const muzzleMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe0b0,
    transparent: true,
    depthWrite: false,
    // The camera sits behind the player's own shoulder, so a depth tested flash spends
    // most of its eighty milliseconds hidden inside the back of the character's head.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const muzzle = new THREE.Mesh(muzzleGeometry, muzzleMaterial);
  muzzle.renderOrder = 2;
  muzzle.visible = false;
  scene.add(muzzle);

  const players = new Map<string, RemotePlayer>();
  const drones = new Map<string, DroneView>();
  const bolts = new Map<string, { mesh: THREE.Mesh; track: Track; seenAt: number }>();
  const wrecks: Wreck[] = [];
  const sparks: Spark[] = [];

  let me: Character | null = null;
  let mySkin = "default";
  let marker: THREE.Mesh | null = null;
  let gear: Gear = { blaster: "mk1", skin: "default", sprint: false };
  let predicted: Place = { x: map.spawn.x, z: map.spawn.z };
  /** The same walk, run from the newest server position with the intents it has not seen. */
  let truth: Place = { x: map.spawn.x, z: map.spawn.z };
  const pending: (SentMove & { at: number })[] = [];
  /**
   * The body walks the intents that were sent, not the thumb as it is right now. The
   * server walks exactly these, so the two agree at the start and the end of a walk
   * instead of disagreeing by one sample, which is the jolt a phone feels as a pull-back.
   */
  let applied: { dx: number; dz: number } = { dx: 0, dz: 0 };
  let shield = 3;
  let downed = false;
  let lastFrameAt = 0;
  let aimHot = false;
  let promptNow: Prompt | null = null;
  let lastCorrection = 0;
  let maxCorrection = 0;
  let firedAt = 0;
  let shotFresh = false;
  const shotEnd = new THREE.Vector3();
  let ringShown = false;

  function characterFor(skin: string): Character {
    const character = createCharacter(skin);
    scene.add(character.group);
    return character;
  }

  /** Puts the player's own body in the coat they are wearing now, and only when it changed. */
  function wearSkin(skin: string): void {
    if (!me || skin === mySkin) return;
    scene.remove(me.group);
    me.dispose();
    me = characterFor(skin);
    mySkin = skin;
  }

  function dropPlayer(entry: RemotePlayer): void {
    scene.remove(entry.character.group);
    entry.character.dispose();
  }

  function trackPlayer(wire: PlayerWire, at: number): void {
    if (wire.id === you) {
      reconcile(wire);
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
      if (!me) {
        me = characterFor(wire.gear.skin);
        mySkin = wire.gear.skin;
      } else {
        wearSkin(wire.gear.skin);
      }
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
      truth = { x: event.x, z: event.z };
      pending.length = 0;
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

  /** One walk the way the server walks it: its speed, in slices, sliding along the walls. */
  function stepAlong(from: Place, dx: number, dz: number, seconds: number): Place {
    if (downed || seconds <= 0 || (dx === 0 && dz === 0)) return from;

    const speed = gear.sprint ? SPRINT_SPEED : WALK_SPEED;
    const clamp = (value: number) => (value < -limit ? -limit : value > limit ? limit : value);
    let place = from;
    let left = Math.min(seconds, 2);
    while (left > 0) {
      const slice = Math.min(left, STEP_CAP);
      left -= slice;
      const wanted = {
        x: clamp(place.x + dx * speed * slice),
        z: clamp(place.z + dz * speed * slice),
      };
      place = slideAgainstBoxes(place, wanted, PLAYER_RADIUS, boxes);
    }
    return place;
  }

  /**
   * The server's answer for this player turned into a position for now: rewind to where it
   * says the body is, drop the intents it has already applied, and walk the rest again.
   * A frame without `seq` comes from a server that does not echo yet, and is read as
   * "everything applied", which is the behaviour this replaced.
   */
  function reconcile(wire: PlayerWire): void {
    const applied = typeof wire.seq === "number" ? wire.seq : Number.POSITIVE_INFINITY;
    while (pending.length > 0 && (pending[0] as SentMove).seq <= applied) pending.shift();

    const until = lastFrameAt > 0 ? lastFrameAt : performance.now();
    let place: Place = { x: wire.x, z: wire.z };
    for (let index = 0; index < pending.length; index++) {
      const move = pending[index] as SentMove & { at: number };
      const after = pending[index + 1] as (SentMove & { at: number }) | undefined;
      const ends = Math.min(after === undefined ? until : after.at, until);
      place = stepAlong(place, move.dx, move.dz, (ends - move.at) / 1000);
    }
    truth = place;
  }

  function stepLocal(dt: number, look: { yaw: number; pitch: number }): number {
    const walked = stepAlong(predicted, applied.dx, applied.dz, dt);
    const travelled = Math.hypot(walked.x - predicted.x, walked.z - predicted.z);
    predicted = walked;

    // The replayed body takes the same step in the same frame, so the gap between the two
    // only ever closes. Easing toward a position that stands still is what used to drag
    // the player backwards on a slow connection.
    truth = stepAlong(truth, applied.dx, applied.dz, dt);

    const gap = Math.hypot(truth.x - predicted.x, truth.z - predicted.z);
    const real = gap - JITTER_METRES;
    if (gap > SNAP_METRES) {
      lastCorrection = gap;
      predicted = { x: truth.x, z: truth.z };
    } else if (real > 0) {
      const wanted = real * SMOOTHING;
      const step = Math.min(wanted, CORRECTION_CAP);
      const share = step / gap;
      lastCorrection = step;
      predicted = {
        x: predicted.x + (truth.x - predicted.x) * share,
        z: predicted.z + (truth.z - predicted.z) * share,
      };
    } else {
      lastCorrection = 0;
    }
    if (lastCorrection > maxCorrection) maxCorrection = lastCorrection;

    if (me) {
      me.group.position.set(predicted.x, 0, predicted.z);
      me.group.rotation.y = look.yaw;
      me.setMoving(dt > 0 ? travelled / dt : 0);
      me.update(dt);
    }
    if (marker) marker.position.set(predicted.x, 0.03, predicted.z);

    return travelled;
  }

  const eye = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const muzzleAt = new THREE.Vector3();
  const along = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  /** True when a building stands between the player's eye and the drone, as on the server. */
  function behindWall(from: THREE.Vector3, to: THREE.Vector3): boolean {
    for (const building of blockers) {
      if (segmentHitsBox(from, to, building.aabb, 0, building.height)) return true;
    }
    return false;
  }

  /**
   * The drone a tap would shoot: the nearest live one inside the thumb cone with nothing
   * in the way. The aim that comes back points at its centre, well inside the cone the
   * server counts, so pointing roughly at a drone is enough.
   */
  function assist(look: { yaw: number; pitch: number }): Shot | null {
    eye.set(predicted.x, EYE_HEIGHT, predicted.z);

    let best: Shot | null = null;
    for (const drone of drones.values()) {
      if (drone.hp <= 0) continue;
      const at = drone.group.position;
      const dx = at.x - eye.x;
      const dy = at.y - eye.y;
      const dz = at.z - eye.z;
      const flat = Math.hypot(dx, dz);
      const distance = Math.hypot(dx, dy, dz);
      if (distance > HITSCAN_RANGE || flat < 0.001) continue;

      let off = Math.atan2(dx, dz) - look.yaw;
      while (off > Math.PI) off -= Math.PI * 2;
      while (off < -Math.PI) off += Math.PI * 2;
      if (Math.abs(off) > ASSIST_CONE) continue;
      if (best !== null && distance >= best.distance) continue;
      if (behindWall(eye, at)) continue;

      best = { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, flat), at, distance };
    }
    return best;
  }

  /**
   * The ring over that drone, published as CSS variables rather than as React state: the
   * HUD reads them in its own style, so nothing re-renders sixty times a second.
   */
  function paintRing(shot: Shot | null): void {
    const root = document.documentElement;
    const hide = () => {
      if (!ringShown) return;
      root.style.setProperty("--aim-on", "0");
      ringShown = false;
    };
    if (!shot) return hide();

    ndc.copy(shot.at).project(camera);
    if (ndc.z > 1) return hide();

    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const perMetre = height / 2 / Math.max(1, shot.distance * Math.tan((camera.fov * Math.PI) / 360));
    const size = Math.max(34, Math.min(140, perMetre * 2.6));

    root.style.setProperty("--aim-x", `${((ndc.x * 0.5 + 0.5) * width).toFixed(1)}px`);
    root.style.setProperty("--aim-y", `${((0.5 - ndc.y * 0.5) * height).toFixed(1)}px`);
    root.style.setProperty("--aim-size", `${size.toFixed(1)}px`);
    if (ringShown) return;
    root.style.setProperty("--aim-on", "1");
    ringShown = true;
  }

  /** The shot this phone draws the instant the trigger is pulled, before the server answers. */
  function drawShot(yaw: number, pitch: number, distance: number): void {
    const flat = Math.cos(pitch);
    along.set(Math.sin(yaw) * flat, Math.sin(pitch), Math.cos(yaw) * flat);
    // Minus the yaw's cosine puts the blaster on the side of the body the camera sees as
    // the right hand, rather than hiding it behind the player's back.
    muzzleAt.set(
      predicted.x + along.x * MUZZLE_FORWARD - Math.cos(yaw) * MUZZLE_SIDE,
      MUZZLE_HEIGHT,
      predicted.z + along.z * MUZZLE_FORWARD + Math.sin(yaw) * MUZZLE_SIDE,
    );

    tracer.position.copy(muzzleAt);
    tracer.quaternion.setFromUnitVectors(UP, along);
    tracer.scale.set(1, Math.max(1, distance), 1);
    tracerMaterial.opacity = 1;
    tracer.visible = true;
    shotFresh = true;

    muzzleMaterial.opacity = 1;
    muzzle.position.copy(muzzleAt);
    muzzle.scale.setScalar(1.7);
    muzzle.visible = true;
  }

  function fadeShot(now: number): void {
    if (!tracer.visible) return;
    // A phone dropping to thirty frames a second would otherwise draw the whole tracer
    // half faded, so the first frame after the trigger always gets it at full strength.
    if (shotFresh) {
      shotFresh = false;
      return;
    }
    const age = now - firedAt;
    if (age >= TRACER_MS) {
      tracer.visible = false;
      muzzle.visible = false;
      return;
    }
    const left = 1 - age / TRACER_MS;
    tracerMaterial.opacity = left;
    muzzleMaterial.opacity = left;
    muzzle.scale.setScalar(0.6 + left * 1.1);
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
        truth = { x: mine.x, z: mine.z };
        pending.length = 0;
        applied = { dx: 0, dz: 0 };
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
      wearSkin(next.skin);
    },

    noteMove(move) {
      applied = { dx: move.dx, dz: move.dz };
      pending.push({ ...move, at: performance.now() });
      if (pending.length > PENDING_MAX) pending.shift();
    },

    fire(yaw, pitch) {
      const shot = assist({ yaw, pitch });
      const aim = shot === null ? { yaw, pitch } : { yaw: shot.yaw, pitch: shot.pitch };

      // The trigger already holds to the gear's rate; this keeps the tracer honest even if
      // a second caller ever pulls it, so the screen never shows a shot the server refused.
      const now = performance.now();
      const gap = FIRE_EVERY_MS[gear.blaster] ?? 250;
      if (now - firedAt >= gap - 4) {
        firedAt = now;
        drawShot(aim.yaw, aim.pitch, shot === null ? HITSCAN_RANGE : shot.distance);
        if (typeof navigator.vibrate === "function") navigator.vibrate(10);
      }
      return aim;
    },

    frame(now) {
      const dt = lastFrameAt === 0 ? 0.016 : Math.min(0.1, (now - lastFrameAt) / 1000);
      lastFrameAt = now;

      const look = options.readLook();
      stepLocal(dt, look);
      drawRemotes(now - INTERPOLATION_MS, dt, now);

      rig.update(camera, predicted, look.yaw, look.pitch, blockers, dt);
      lampGlow.update(lamps, predicted.x, predicted.z);

      const shot = assist(look);
      paintRing(shot);
      fadeShot(now);

      const hot = shot !== null;
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
      correction: lastCorrection,
      maxCorrection,
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
      scene.remove(tracer);
      tracerGeometry.dispose();
      tracerMaterial.dispose();
      scene.remove(muzzle);
      muzzleGeometry.dispose();
      muzzleMaterial.dispose();
      document.documentElement.style.setProperty("--aim-on", "0");
      ringShown = false;

      disposeDrones();
      lampGlow.dispose();
      disposeCity(city, assets);
      scene.remove(city);
      boltGeometry.dispose();
      boltMaterial.dispose();
      sparkMaterial.dispose();
      renderer.dispose();
    },
  };
}
