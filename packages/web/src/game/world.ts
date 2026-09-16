import * as THREE from "three";
import type { BoltWire, DroneWire, PlayerWire, StateFrame, TickEvent, WelcomeFrame } from "@/lib/ws";
import type { Gear } from "@/lib/api";
import { createCameraRig, type Blocker } from "./camera";
import type { Box, WorldMap } from "./map";
import { segmentHitsBox, slideAgainstBoxes } from "./slide";
import type { SentMove } from "./controls";
import {
  createMarkers,
  type DroneSight,
  type MarkerReadout,
  type MarkerSpot,
  type Markers,
  type Objective,
} from "./markers";
import type { CityAssets } from "./scene/assets";
import { createAtmosphere, type Atmosphere } from "./scene/atmosphere";
import { animateCity, buildCity, disposeCity, lampSpots } from "./scene/city";
import { createCharacter, type Character } from "./scene/character";
import { animateDrone, createDrone, disposeDrone, disposeDrones } from "./scene/drone";
import { addLampGlow, addNightLights } from "./scene/lights";
import { tuneRenderer, type Look } from "./scene/materials";
import { createNeon, type Neon } from "./scene/neon";
import { scenePixelRatio } from "./scene/pixelRatio";

/**
 * The world as the phone draws it.
 *
 * The server is the authority, so everything here is a reading of frames that already
 * happened: other players and the drones are drawn 100 ms behind the clock, between the
 * last two positions the server sent, which is what makes them glide instead of stutter.
 *
 * The player's own body is the exception, and at a quarter of a second of round trip it
 * is the whole game. The body is walked from the live thumb on every rendered frame, so
 * it moves at the refresh rate rather than at the rate intents go out.
 *
 * Every move intent that goes out is kept with the span it covered. When a frame comes
 * back the server position is taken as truth, the intents the server has already applied
 * are dropped, and the rest are replayed from that position. Whatever the replay
 * disagrees with is held as an offset on top of the walk and bled off over 200 ms, so a
 * correction is never a step and never a pull backwards: it only ever slows the walk.
 */

/** How far behind the newest frame everything remote is drawn. Two ticks of headroom. */
const INTERPOLATION_MS = 100;

const PLAYER_RADIUS = 0.5;
const WALK_SPEED = 6;
const SPRINT_SPEED = 7;
const EYE_HEIGHT = 1.6;

/** How long a correction takes to bleed away. Three time constants leaves five percent. */
const CORRECTION_MS = 200;

/**
 * The share of a frame's walk a correction may eat. The body always keeps most of its
 * step, so a disagreement slows the walk rather than stopping or reversing it.
 */
const BACK_SHARE = 0.6;

/** No frame may move the body further than the walk itself, plus a whisker for rounding. */
const STEP_MARGIN = 1.08;

/** Further out than this and the walk is a lost cause: the body is put where the replay says. */
const SNAP_METRES = 2;

/** A replayed intent is walked in steps no longer than this, as the server's tick does. */
const STEP_CAP = 0.1;

/** The longest frame the walk is integrated over. A longer gap is a stall, not a stride. */
const FRAME_CAP = 0.05;

/** More than a couple of seconds of unapplied intents means the socket is gone anyway. */
const PENDING_MAX = 64;

/**
 * The floor on how long an unacknowledged intent is kept. Anything older than this, or
 * older than the link's own round trip with room to spare, is dropped: the server will
 * never apply a move that late, so replaying it only walks the body somewhere the server
 * will never agree with.
 */
const PENDING_AGE_MS = 600;

/**
 * How much longer than the measured round trip an intent is kept. Pruning tighter than
 * the round trip would throw away intents the server is still working through, and each
 * one thrown away is a metre of walking the replay would then take back off the body.
 */
const AGE_SLACK = 1.5;

/** The window the readout averages over. */
const SAMPLE_MS = 1000;

/**
 * Frame time that means the phone is struggling, and the time that means it recovered.
 * This is the gap between frames, not the work inside one: WebGL calls are queued, so the
 * time spent submitting them says nothing about what the card is doing with them. A
 * phone that cannot keep up stretches the gap, which is the number the player feels.
 */
const SLOW_FRAME_MS = 20;
const WELL_FRAME_MS = 12;
const SLOW_FOR_MS = 3000;
const WELL_FOR_MS = 5000;

/** What the renderer drops to when the phone cannot hold the frame rate. */
const RELIEF_RATIO = 0.75;

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

/** How long the reduced motion kill flash is up: a frame at sixty, plus a little slack. */
const KILL_FLASH_MS = 70;

const ACCENT = 0xff6a2b;

/** The look Ram approved on the lab page. The hero still runs the first one. */
const LOOK: Look = "v2";

const dev = process.env.NODE_ENV !== "production";

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
  /** The thumb as it is on this frame, already turned into a world direction. */
  readMove: () => { dx: number; dz: number };
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
  /** The places worth a beam of light right now, worked out from the day's quest rows. */
  setMarkers: (spots: MarkerSpot[]) => void;
  /** The one thing to do next, which the brightest beam and the compass both follow. */
  setObjective: (objective: Objective | null) => void;
  /** What the wayfinding layer is drawing, so a test can count it and read the target. */
  markers: () => MarkerReadout;
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
    /** The correction still bleeding off the walk, in metres. */
    offset: number;
    /** How far the body moved on the last frame, and the worst frame of the last second. */
    step: number;
    worstStep: number;
    stepCap: number;
  };
  /** Everything the readout panel shows, read on a timer rather than every frame. */
  readout: () => Readout;
  /** Where the camera sits, so a test can prove it is not standing inside a building. */
  cameraAt: () => { x: number; y: number; z: number };
  /** When the reduced motion kill flash last fired, so a check can prove it did. */
  killFlashAt: () => number;
  dispose: () => void;
};

export type Readout = {
  fps: number;
  frameMs: number;
  /** Time spent drawing the frame, as against the gap between frames. */
  workMs: number;
  /** How far the server's answer was from the drawn body, worst of the last second. */
  errorMetres: number;
  /** Move intents that went out in the last second. */
  sendRate: number;
  calls: number;
  triangles: number;
  pixelRatio: number;
  width: number;
  height: number;
  bufferWidth: number;
  bufferHeight: number;
  webgl: number;
  gpu: string;
  reliefMode: boolean;
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
  tuneRenderer(renderer, LOOK);

  /** The card the phone actually draws with, when the browser is willing to name it. */
  const gpu = ((): string => {
    try {
      const gl = renderer.getContext();
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      if (info === null) return "not reported";
      return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    } catch {
      return "not reported";
    }
  })();

  const scene = new THREE.Scene();
  addNightLights(scene, map.size, LOOK);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.2, 520);
  const rig = createCameraRig();

  const city = buildCity(map, assets, LOOK);
  scene.add(city);

  const sky: Atmosphere = createAtmosphere(map);
  scene.add(sky.group);
  const neon: Neon = createNeon(map);
  scene.add(neon.group);

  const lamps = lampSpots(map);
  const lampGlow = addLampGlow(scene);

  const markers: Markers = createMarkers({ scene, reduced });
  /** Refilled each frame: a handful of readings for the beacons, the strip and the rings. */
  const sighted: DroneSight[] = [];

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

  /** The white frame a kill gets when the phone has asked for less motion. */
  const killFlashMaterial = new THREE.SpriteMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const killFlash = new THREE.Sprite(killFlashMaterial);
  killFlash.scale.setScalar(2.6);
  killFlash.renderOrder = 5;
  killFlash.visible = false;
  scene.add(killFlash);
  let killFlashAt = 0;

  const players = new Map<string, RemotePlayer>();
  const drones = new Map<string, DroneView>();
  const bolts = new Map<string, { mesh: THREE.Mesh; track: Track; seenAt: number }>();
  const wrecks: Wreck[] = [];
  const sparks: Spark[] = [];

  let me: Character | null = null;
  let mySkin = "default";
  let marker: THREE.Mesh | null = null;
  let gear: Gear = { blaster: "mk1", skin: "default", sprint: false };
  /** The walk the client believes in: the server's last word, plus everything since. */
  let predicted: Place = { x: map.spawn.x, z: map.spawn.z };
  /** What is actually drawn: that walk, plus the correction still bleeding off it. */
  let body: Place = { x: map.spawn.x, z: map.spawn.z };
  let offsetX = 0;
  let offsetZ = 0;
  const pending: (SentMove & { at: number })[] = [];
  /** The live thumb on the last frame, and the moment it last changed direction. */
  let heading: { dx: number; dz: number } = { dx: 0, dz: 0 };
  let headingSince = 0;
  let shield = 3;
  let downed = false;
  let lastFrameAt = 0;
  let aimHot = false;
  let promptNow: Prompt | null = null;
  let lastCorrection = 0;
  let maxCorrection = 0;
  let lastStep = 0;
  let stepCap = 0;
  /** Rolling windows the readout averages: frame times, render steps, intents, errors. */
  const frameTimes: { t: number; ms: number }[] = [];
  const workTimes: { t: number; ms: number }[] = [];
  const stepSizes: { t: number; step: number }[] = [];
  const sends: number[] = [];
  const errors: { t: number; metres: number }[] = [];
  let slowSince = 0;
  let wellSince = 0;
  let reliefMode = false;
  /** How old the newest acknowledged intent is: the link's round trip, as measured here. */
  let ackAgeMs = 0;
  let firedAt = 0;
  let shotFresh = false;
  const shotEnd = new THREE.Vector3();
  let ringShown = false;

  function characterFor(skin: string): Character {
    const character = createCharacter(skin, LOOK);
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
      const group = createDrone(LOOK);
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
    // No sparks under reduced motion, so the kill is carried by one white frame over the
    // drone instead. The window is a frame and a bit, so a dropped frame cannot eat it.
    if (reduced) {
      killFlash.position.set(at.x, at.y, at.z);
      killFlashAt = now;
    }
  }

  function handleEvent(event: TickEvent, now: number): void {
    if (event.kind === "hit" || event.kind === "droneHit") {
      const view = event.kind === "hit" ? drones.get(event.drone) : null;
      if (view) view.flashUntil = now + HIT_FLASH_MS;
      return;
    }
    // The three quiet jobs. The quest toast is a database round trip away, so the city
    // answers on the frame the event arrives: the beam lifts, a ring crosses the road and
    // a glow comes off the player.
    if (event.kind === "landmark") {
      if (event.player !== you) return;
      const place = map.landmarks[event.index];
      if (place) markers.touch(place, `landmark:${event.index}`, now);
      return;
    }
    if (event.kind === "pickup" || event.kind === "deliver") {
      if (event.player !== you) return;
      const place = map.courier[event.point];
      if (place) markers.touch(place, "courier", now);
      return;
    }
    if (event.kind === "kill") {
      killDrone(event.drone, new THREE.Vector3(event.x, event.y, event.z), now);
      if (event.player === you) options.onEvent({ kind: "kill" });
      return;
    }
    if (event.kind === "respawn" && event.player === you) {
      predicted = { x: event.x, z: event.z };
      body = { x: event.x, z: event.z };
      offsetX = 0;
      offsetZ = 0;
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
      const range = Math.hypot(place.x - body.x, place.z - body.z);
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

  /** How old an unacknowledged intent has to be before it is given up on. */
  function staleAfter(): number {
    return Math.max(PENDING_AGE_MS, ackAgeMs * AGE_SLACK);
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
   * says the body is, drop the intents it has already applied or that are now too old for
   * it to ever apply, and walk the rest again. A frame without `seq` comes from a server
   * that does not echo yet, and is read as everything applied.
   *
   * Whatever is left between that answer and the drawn body becomes the offset, which the
   * frame loop bleeds away. The drawn body does not move here at all: a correction that
   * moved it would be the step this whole file exists to avoid.
   */
  function reconcile(wire: PlayerWire): void {
    const seen = typeof wire.seq === "number" ? wire.seq : Number.POSITIVE_INFINITY;
    const now = performance.now();

    // The newest intent the server has owned up to tells this client what its own round
    // trip really is, without a ping and without trusting the clocks to agree.
    let acked = 0;
    for (const entry of pending) {
      if (entry.seq > seen) break;
      acked = now - entry.at;
    }
    if (acked > 0) ackAgeMs = Math.max(acked, ackAgeMs * 0.9);

    const stale = staleAfter();
    while (pending.length > 0) {
      const oldest = pending[0] as SentMove & { at: number };
      if (oldest.seq > seen && now - oldest.at <= stale) break;
      pending.shift();
    }

    const until = lastFrameAt > 0 ? lastFrameAt : now;
    let place: Place = { x: wire.x, z: wire.z };
    for (let index = 0; index < pending.length; index++) {
      const move = pending[index] as SentMove & { at: number };
      const after = pending[index + 1] as (SentMove & { at: number }) | undefined;
      const ends = Math.min(after === undefined ? until : after.at, until);
      place = stepAlong(place, move.dx, move.dz, (ends - move.at) / 1000);
    }

    predicted = place;
    offsetX = body.x - place.x;
    offsetZ = body.z - place.z;

    const error = Math.hypot(offsetX, offsetZ);
    lastCorrection = error;
    if (error > maxCorrection) maxCorrection = error;
    errors.push({ t: now, metres: error });
    while (errors.length > 0 && now - (errors[0] as { t: number }).t > SAMPLE_MS) errors.shift();

    // Two metres out is not a disagreement any more, it is a different game.
    if (error <= SNAP_METRES) return;
    offsetX = 0;
    offsetZ = 0;
    body = { x: place.x, z: place.z };
  }

  /**
   * One rendered frame of walking. The walk comes from the live thumb, and the correction
   * rides on top as an offset that decays, is never allowed to eat more than part of the
   * step, and is never allowed to carry the body further than a walk would.
   */
  function stepLocal(
    dt: number,
    dir: { dx: number; dz: number },
    look: { yaw: number; pitch: number },
  ): number {
    const speed = gear.sprint ? SPRINT_SPEED : WALK_SPEED;
    const fromX = body.x;
    const fromZ = body.z;

    const walked = stepAlong(predicted, dir.dx, dir.dz, dt);
    const forward = Math.hypot(walked.x - predicted.x, walked.z - predicted.z);
    predicted = walked;

    const keep = Math.exp((-dt * 1000 * 3) / CORRECTION_MS);
    let nextX = offsetX * keep;
    let nextZ = offsetZ * keep;

    const given = (nextX - offsetX) * dir.dx + (nextZ - offsetZ) * dir.dz;
    const floor = -BACK_SHARE * forward;
    if (given < floor) {
      nextX += dir.dx * (floor - given);
      nextZ += dir.dz * (floor - given);
    }

    let stepX = walked.x + nextX - fromX;
    let stepZ = walked.z + nextZ - fromZ;
    const length = Math.hypot(stepX, stepZ);
    stepCap = speed * dt * STEP_MARGIN;
    if (length > stepCap) {
      const share = stepCap / length;
      stepX *= share;
      stepZ *= share;
    }

    // The offset is a straight line, so the spot it lands on is slid too: a correction is
    // not allowed to post the body through a wall the walk itself went around.
    body = slideAgainstBoxes(
      { x: fromX, z: fromZ },
      { x: fromX + stepX, z: fromZ + stepZ },
      PLAYER_RADIUS,
      boxes,
    );
    offsetX = body.x - predicted.x;
    offsetZ = body.z - predicted.z;

    const travelled = Math.hypot(body.x - fromX, body.z - fromZ);
    lastStep = travelled;

    if (me) {
      me.group.position.set(body.x, 0, body.z);
      me.group.rotation.y = look.yaw;
      me.setMoving(dt > 0 ? travelled / dt : 0);
      me.update(dt);
    }
    if (marker) marker.position.set(body.x, 0.03, body.z);

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
    eye.set(body.x, EYE_HEIGHT, body.z);

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
      body.x + along.x * MUZZLE_FORWARD - Math.cos(yaw) * MUZZLE_SIDE,
      MUZZLE_HEIGHT,
      body.z + along.z * MUZZLE_FORWARD + Math.sin(yaw) * MUZZLE_SIDE,
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

  /**
   * A phone that cannot hold the frame rate for three seconds is given fewer pixels to
   * draw, and gets them back once it has been comfortable for five. The window is cleared
   * on a switch so the new pixel count is judged on its own frames.
   */
  function watchFrameRate(now: number): void {
    if (frameTimes.length < 12) return;
    let total = 0;
    for (const entry of frameTimes) total += entry.ms;
    const average = total / frameTimes.length;

    if (average > SLOW_FRAME_MS) {
      wellSince = 0;
      if (slowSince === 0) slowSince = now;
    } else if (average < WELL_FRAME_MS) {
      slowSince = 0;
      if (wellSince === 0) wellSince = now;
    } else {
      slowSince = 0;
      wellSince = 0;
    }

    const fall = !reliefMode && slowSince > 0 && now - slowSince >= SLOW_FOR_MS;
    const rise = reliefMode && wellSince > 0 && now - wellSince >= WELL_FOR_MS;
    if (!fall && !rise) return;

    reliefMode = fall;
    slowSince = 0;
    wellSince = 0;
    frameTimes.length = 0;
    workTimes.length = 0;
    resize();
  }

  /** What the phone is asked to draw per CSS pixel, less when it cannot keep up. */
  function targetRatio(): number {
    const base = scenePixelRatio();
    return reliefMode ? Math.min(base, RELIEF_RATIO) : base;
  }

  function resize(): void {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(targetRatio());
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
        body = { x: mine.x, z: mine.z };
        offsetX = 0;
        offsetZ = 0;
        pending.length = 0;
        heading = { dx: 0, dz: 0 };
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
      const now = performance.now();
      const last = pending[pending.length - 1];
      // Each intent covers from its own stamp until the next one's, so a resend of the
      // same direction starts now: the intent before it already covered the gap. Only a
      // change of direction is backdated, to the moment the thumb actually turned, which
      // is what puts the replay on the path the frames walked rather than one slot behind.
      const since = headingSince > 0 ? headingSince : now;
      const same =
        last !== undefined &&
        Math.abs(last.dx - move.dx) < 0.01 &&
        Math.abs(last.dz - move.dz) < 0.01;
      let at = now;
      if (last === undefined) at = Math.min(now, since);
      else if (!same) at = Math.min(now, Math.max(since, last.at));
      pending.push({ ...move, at });
      const stale = staleAfter();
      while (pending.length > 1 && now - (pending[0] as { at: number }).at > stale) {
        pending.shift();
      }
      if (pending.length > PENDING_MAX) pending.shift();

      sends.push(now);
      while (sends.length > 0 && now - (sends[0] as number) > SAMPLE_MS) sends.shift();
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
      const enter = performance.now();
      const gap = lastFrameAt === 0 ? 16 : now - lastFrameAt;
      const dt = lastFrameAt === 0 ? 0.016 : Math.min(FRAME_CAP, gap / 1000);
      lastFrameAt = now;

      const look = options.readLook();
      const wanted = options.readMove();
      const moving = wanted.dx !== 0 || wanted.dz !== 0;
      const wasMoving = heading.dx !== 0 || heading.dz !== 0;
      const turned =
        moving !== wasMoving ||
        (moving && wanted.dx * heading.dx + wanted.dz * heading.dz < 0.999);
      if (turned) headingSince = now;
      heading = wanted;

      const step = stepLocal(dt, wanted, look);
      frameTimes.push({ t: now, ms: gap });
      while (frameTimes.length > 0 && now - (frameTimes[0] as { t: number }).t > SAMPLE_MS) {
        frameTimes.shift();
      }
      stepSizes.push({ t: now, step });
      while (stepSizes.length > 0 && now - (stepSizes[0] as { t: number }).t > SAMPLE_MS) {
        stepSizes.shift();
      }
      if (dev && moving && (step <= 0 || step > stepCap + 1e-6)) {
        console.warn(`[vettai] render step ${step.toFixed(4)} m against a cap of ${stepCap.toFixed(4)} m`);
      }

      drawRemotes(now - INTERPOLATION_MS, dt, now);

      rig.update(camera, body, look.yaw, look.pitch, blockers, dt);
      lampGlow.update(lamps, body.x, body.z);

      // The sky, the signs and the lamp flicker all run off one clock, held still when
      // the phone asks for less motion.
      const sceneTime = reduced ? 0 : now / 1000;
      animateCity(city, sceneTime);
      neon.update(sceneTime);
      sky.update(sceneTime, camera.position);

      sighted.length = 0;
      for (const drone of drones.values()) {
        if (drone.hp <= 0) continue;
        const at = drone.group.position;
        sighted.push({ x: at.x, y: at.y, z: at.z });
      }
      markers.frame(now, camera, body, look.yaw, sighted);

      killFlash.visible = killFlashAt > 0 && now - killFlashAt < KILL_FLASH_MS;

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

      workTimes.push({ t: now, ms: performance.now() - enter });
      while (workTimes.length > 0 && now - (workTimes[0] as { t: number }).t > SAMPLE_MS) {
        workTimes.shift();
      }
      watchFrameRate(now);
    },

    resume(now) {
      lastFrameAt = now;
    },

    resize,

    setMarkers: (spots) => markers.setSpots(spots),

    setObjective: (objective) => markers.setObjective(objective),

    markers: () => markers.readout(),

    place: () => ({ x: body.x, z: body.z }),

    cameraAt: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }),

    killFlashAt: () => killFlashAt,

    stats: () => {
      let worstStep = 0;
      for (const entry of stepSizes) if (entry.step > worstStep) worstStep = entry.step;
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        correction: lastCorrection,
        maxCorrection,
        offset: Math.hypot(offsetX, offsetZ),
        step: lastStep,
        worstStep,
        stepCap,
      };
    },

    readout: () => {
      const now = performance.now();
      while (sends.length > 0 && now - (sends[0] as number) > SAMPLE_MS) sends.shift();
      while (errors.length > 0 && now - (errors[0] as { t: number }).t > SAMPLE_MS) errors.shift();

      let total = 0;
      for (const entry of frameTimes) total += entry.ms;
      let work = 0;
      for (const entry of workTimes) work += entry.ms;
      let worstError = 0;
      for (const entry of errors) if (entry.metres > worstError) worstError = entry.metres;

      const buffer = new THREE.Vector2();
      renderer.getDrawingBufferSize(buffer);

      return {
        fps: frameTimes.length,
        frameMs: frameTimes.length > 0 ? total / frameTimes.length : 0,
        workMs: workTimes.length > 0 ? work / workTimes.length : 0,
        errorMetres: worstError,
        sendRate: sends.length,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        pixelRatio: renderer.getPixelRatio(),
        width: canvas.clientWidth || window.innerWidth,
        height: canvas.clientHeight || window.innerHeight,
        bufferWidth: Math.round(buffer.x),
        bufferHeight: Math.round(buffer.y),
        webgl: renderer.capabilities.isWebGL2 ? 2 : 1,
        gpu,
        reliefMode,
      };
    },

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
      scene.remove(killFlash);
      killFlashMaterial.dispose();
      document.documentElement.style.setProperty("--aim-on", "0");
      ringShown = false;

      markers.dispose();
      disposeDrones();
      scene.remove(neon.group);
      neon.dispose();
      scene.remove(sky.group);
      sky.dispose();
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
