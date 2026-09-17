"use client";

/**
 * The city's sound, built in the browser.
 *
 * Nothing here is downloaded. Every shot, every hit and the street's own hum are made from
 * oscillators, a noise buffer and gain envelopes, so the bundle carries no audio files and
 * there is no licence or format question to answer.
 *
 * Two rules the phone forces on us. A WebView will not start an AudioContext outside a
 * user gesture, so the context is built on the first touch of the play surface and every
 * call before that does nothing. And iOS hands Web Audio to the ringer switch, so a phone
 * on silent is silent whatever this file does: the docs say so rather than the game
 * pretending otherwise.
 */

export type Sfx =
  | "shot"
  | "hit"
  | "kill"
  | "boltIncoming"
  | "shieldHit"
  | "downed"
  | "respawn"
  | "spawn"
  | "pickup"
  | "deliver"
  | "landmark"
  | "questDone"
  | "paid"
  | "tap"
  | "assist"
  | "refused";

const MUTE_KEY = "vettai.muted";

/** How many drones may hum at once. The nearest six, and the rest of the sky stays quiet. */
const MAX_HUMS = 6;

/** The hum, as a share of full scale, before the panner takes the distance off it. */
const HUM_CALM = 0.05;
const HUM_ENGAGED = 0.12;

/** How long a drone takes to fade out of the mix once it is gone. */
const HUM_FADE_MS = 300;

type Place = { x: number; y: number; z: number };

type Hum = {
  low: OscillatorNode;
  high: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
};

type Bed = {
  source: AudioBufferSourceNode;
  fade: GainNode;
  swell: OscillatorNode;
};

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

let context: AudioContext | null = null;
let master: GainNode | null = null;
let hiss: AudioBuffer | null = null;
let rumble: AudioBuffer | null = null;
let muted: boolean | null = null;
/** True once the page is being watched for going away, so the listener is added once. */
let watching = false;
let bedWanted = false;
let bed: Bed | null = null;

const hums = new Map<string, Hum>();
/** What the render loop asked for this frame, read on the next one so the six can be picked. */
const wanted = new Map<string, Place & { engaged: boolean; range: number }>();
let listenAt: Place = { x: 0, y: 0, z: 0 };

const played: Record<string, number> = {};

/** How many times each sound has really come out of the speaker, for the browser checks. */
export function soundsPlayed(): Record<string, number> {
  return played;
}

export function isMuted(): boolean {
  if (muted !== null) return muted;
  if (typeof window === "undefined") return false;
  try {
    muted = window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    muted = false;
  }
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    window.localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  } catch {
    // A WebView with storage turned off still mutes, it just forgets by the next game.
  }

  const ctx = context;
  const out = master;
  if (ctx && out) out.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.02);

  // The loops are stopped rather than left running behind a closed gate: a muted phone
  // should not be spending its battery on twelve oscillators nobody can hear.
  if (next) {
    for (const id of [...hums.keys()]) droneGone(id);
    wanted.clear();
    stopBed();
    return;
  }
  syncBed();
}

/**
 * Builds the context, or wakes a suspended one. Safe to call on every touch: the second
 * call and the thousandth do nothing but the resume.
 */
export function unlockAudio(): void {
  if (typeof window === "undefined") return;

  if (context) {
    if (context.state === "suspended") void context.resume();
    return;
  }

  const make = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
  if (!make) return;

  let made: AudioContext;
  try {
    made = new make();
  } catch {
    return;
  }

  // Everything lands on one limiter. Fifteen sounds and six hums can arrive on the same
  // frame, and a phone speaker turns a sum over one into a crackle.
  const limiter = made.createDynamicsCompressor();
  limiter.threshold.value = -16;
  limiter.knee.value = 14;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.18;
  limiter.connect(made.destination);

  const gain = made.createGain();
  gain.gain.value = isMuted() ? 0 : 1;
  gain.connect(limiter);

  context = made;
  master = gain;
  hiss = whiteNoise(made);
  rumble = brownNoise(made);

  if (made.state === "suspended") void made.resume();
  if (!watching) {
    document.addEventListener("visibilitychange", onVisibility);
    watching = true;
  }
  syncBed();
}

/**
 * The phone went somewhere else: another tab, a call, a locked screen. The whole context
 * is suspended rather than left running behind a game nobody is looking at, and every hum
 * is dropped to nothing first so a context that comes back does not come back holding the
 * level a drone had when the player walked away. The next frames put the levels back.
 */
function onVisibility(): void {
  const ctx = context;
  if (!ctx) return;

  if (document.hidden) {
    const now = ctx.currentTime;
    for (const hum of hums.values()) {
      hum.gain.gain.cancelScheduledValues(now);
      hum.gain.gain.setValueAtTime(0, now);
    }
    wanted.clear();
    void ctx.suspend();
    return;
  }

  if (isMuted()) return;
  void ctx.resume();
}

export function disposeAudio(): void {
  if (watching) {
    document.removeEventListener("visibilitychange", onVisibility);
    watching = false;
  }
  for (const id of [...hums.keys()]) droneGone(id);
  wanted.clear();
  bedWanted = false;
  stopBed();

  const ctx = context;
  context = null;
  master = null;
  hiss = null;
  rumble = null;
  if (!ctx) return;
  try {
    void ctx.close();
  } catch {
    // A context the browser already took away is not a reason to break the unmount.
  }
}

export function play(name: Sfx): void {
  voice(name, null);
}

export function playAt(name: Sfx, x: number, y: number, z: number): void {
  voice(name, { x, y, z });
}

/** The ear, once a frame: where the camera is and which way it faces. */
export function setListener(x: number, y: number, z: number, yaw: number): void {
  const ctx = context;
  if (!ctx) return;

  const ear = ctx.listener;
  const ahead = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  if (ear.positionX) {
    const at = ctx.currentTime;
    ear.positionX.setValueAtTime(x, at);
    ear.positionY.setValueAtTime(y, at);
    ear.positionZ.setValueAtTime(z, at);
    ear.forwardX.setValueAtTime(ahead.x, at);
    ear.forwardY.setValueAtTime(ahead.y, at);
    ear.forwardZ.setValueAtTime(ahead.z, at);
    ear.upX.setValueAtTime(0, at);
    ear.upY.setValueAtTime(1, at);
    ear.upZ.setValueAtTime(0, at);
  } else {
    // Safari still only has the old pair, and it is what a phone in Nimiq Pay runs.
    const old = ear as unknown as {
      setPosition: (x: number, y: number, z: number) => void;
      setOrientation: (
        fx: number,
        fy: number,
        fz: number,
        ux: number,
        uy: number,
        uz: number,
      ) => void;
    };
    old.setPosition(x, y, z);
    old.setOrientation(ahead.x, ahead.y, ahead.z, 0, 1, 0);
  }

  // Last frame's drones, now that the ear has moved: the nearest six get the mix and the
  // rest are held at silence rather than being torn down and rebuilt as the player turns.
  flushHums();
  listenAt = { x, y, z };
}

/** One drone, once a frame. Engaged drones sit higher and louder: that is the warning. */
export function droneHum(id: string, x: number, y: number, z: number, engaged: boolean): void {
  if (!context || isMuted()) return;
  const range = Math.hypot(x - listenAt.x, y - listenAt.y, z - listenAt.z);
  wanted.set(id, { x, y, z, engaged, range });
}

export function droneGone(id: string): void {
  wanted.delete(id);
  const hum = hums.get(id);
  const ctx = context;
  if (!hum || !ctx) return;
  hums.delete(id);

  const now = ctx.currentTime;
  const fade = HUM_FADE_MS / 1000;
  hum.gain.gain.cancelScheduledValues(now);
  hum.gain.gain.setValueAtTime(Math.max(0.0001, hum.gain.gain.value), now);
  hum.gain.gain.linearRampToValueAtTime(0, now + fade);
  hum.low.stop(now + fade + 0.02);
  hum.high.stop(now + fade + 0.02);
  hum.low.onended = () => {
    hum.low.disconnect();
    hum.high.disconnect();
    hum.filter.disconnect();
    hum.gain.disconnect();
    hum.panner.disconnect();
  };
}

/** The street under everything: brown noise, filtered down to a rumble, breathing slowly. */
export function cityBed(on: boolean): void {
  bedWanted = on;
  syncBed();
}

function flushHums(): void {
  const ctx = context;
  const out = master;
  if (!ctx || !out) return wanted.clear();

  const now = ctx.currentTime;
  const rows = [...wanted.entries()].sort((a, b) => a[1].range - b[1].range);

  rows.forEach(([id, row], index) => {
    const near = index < MAX_HUMS;
    let hum = hums.get(id) ?? null;
    if (!hum) {
      if (!near) return;
      hum = startHum(ctx, out);
      hums.set(id, hum);
    }

    place(hum.panner, row.x, row.y, row.z);
    const level = near ? (row.engaged ? HUM_ENGAGED : HUM_CALM) : 0;
    const pitch = row.engaged ? 78 : 52;
    hum.gain.gain.setTargetAtTime(level, now, 0.08);
    hum.low.frequency.setTargetAtTime(pitch, now, 0.12);
    hum.high.frequency.setTargetAtTime(pitch * 1.012, now, 0.12);
    hum.filter.frequency.setTargetAtTime(row.engaged ? 900 : 520, now, 0.12);
  });

  // A drone the render loop stopped naming without a droneGone: the socket dropped it
  // between frames, and a hum with nothing behind it would hang in the air for ever.
  for (const id of [...hums.keys()]) {
    if (!wanted.has(id)) droneGone(id);
  }
  wanted.clear();
}

function startHum(ctx: AudioContext, out: GainNode): Hum {
  const panner = ctx.createPanner();
  panner.panningModel = "equalpower";
  panner.distanceModel = "inverse";
  panner.refDistance = 5;
  panner.maxDistance = 120;
  panner.rolloffFactor = 1.1;
  panner.connect(out);

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(panner);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 520;
  filter.Q.value = 3;
  filter.connect(gain);

  // Two saws a hair apart. The beat between them is what makes it a machine rather than
  // a test tone.
  const low = ctx.createOscillator();
  low.type = "sawtooth";
  low.frequency.value = 52;
  low.connect(filter);
  low.start();

  const high = ctx.createOscillator();
  high.type = "sawtooth";
  high.frequency.value = 52 * 1.012;
  high.detune.value = 6;
  high.connect(filter);
  high.start();

  return { low, high, filter, gain, panner };
}

function syncBed(): void {
  const ctx = context;
  const out = master;
  if (!ctx || !out) return;
  if (!bedWanted) return stopBed();
  if (bed || !rumble || isMuted()) return;

  const source = ctx.createBufferSource();
  source.buffer = rumble;
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 260;
  filter.Q.value = 0.7;

  const level = ctx.createGain();
  level.gain.value = 0.045;

  // One slow breath every ten seconds, so the street never sits perfectly still.
  const swell = ctx.createOscillator();
  swell.frequency.value = 0.1;
  const depth = ctx.createGain();
  depth.gain.value = 0.02;
  swell.connect(depth);
  depth.connect(level.gain);
  swell.start();

  const now = ctx.currentTime;
  const fade = ctx.createGain();
  fade.gain.setValueAtTime(0, now);
  fade.gain.linearRampToValueAtTime(1, now + 2);

  source.connect(filter);
  filter.connect(level);
  level.connect(fade);
  fade.connect(out);
  source.start();

  bed = { source, fade, swell };
}

function stopBed(): void {
  const ctx = context;
  const live = bed;
  bed = null;
  if (!live || !ctx) return;
  const now = ctx.currentTime;
  live.fade.gain.cancelScheduledValues(now);
  live.fade.gain.setValueAtTime(live.fade.gain.value, now);
  live.fade.gain.linearRampToValueAtTime(0, now + 0.6);
  live.source.stop(now + 0.7);
  live.swell.stop(now + 0.7);
  live.source.onended = () => {
    live.source.disconnect();
    live.fade.disconnect();
    live.swell.disconnect();
  };
}

function voice(name: Sfx, at: Place | null): void {
  const ctx = context;
  const out = master;
  if (!ctx || !out || isMuted()) return;

  let target: AudioNode = out;
  let panner: PannerNode | null = null;
  if (at) {
    panner = ctx.createPanner();
    panner.panningModel = "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = 4;
    panner.maxDistance = 120;
    panner.rolloffFactor = 1.1;
    place(panner, at.x, at.y, at.z);
    panner.connect(out);
    target = panner;
  }

  const length = SOUNDS[name](ctx, target, ctx.currentTime);
  played[name] = (played[name] ?? 0) + 1;

  if (!panner) return;
  const loose = panner;
  window.setTimeout(() => loose.disconnect(), length * 1000 + 200);
}

function place(panner: PannerNode, x: number, y: number, z: number): void {
  if (panner.positionX) {
    const at = panner.context.currentTime;
    panner.positionX.setValueAtTime(x, at);
    panner.positionY.setValueAtTime(y, at);
    panner.positionZ.setValueAtTime(z, at);
    return;
  }
  (panner as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(
    x,
    y,
    z,
  );
}

/**
 * One envelope: up from nothing in `attack`, down to nothing by `length`. Exponential in
 * both directions, because a linear fall on a phone speaker reads as a click.
 */
function shape(
  ctx: AudioContext,
  to: AudioNode,
  peak: number,
  start: number,
  attack: number,
  length: number,
): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  gain.connect(to);
  return gain;
}

function tone(
  ctx: AudioContext,
  to: AudioNode,
  kind: OscillatorType,
  from: number,
  until: number,
  start: number,
  length: number,
  peak: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = kind;
  osc.frequency.setValueAtTime(from, start);
  if (until !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, until), start + length);

  const gain = shape(ctx, to, peak, start, Math.min(0.012, length / 4), length);
  osc.connect(gain);
  osc.start(start);
  osc.stop(start + length + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

function noise(
  ctx: AudioContext,
  to: AudioNode,
  start: number,
  length: number,
  peak: number,
  from: number,
  until: number,
): void {
  if (!hiss) return;
  const source = ctx.createBufferSource();
  source.buffer = hiss;
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(from, start);
  if (until !== from) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, until), start + length);
  }
  filter.Q.value = 0.9;

  const gain = shape(ctx, to, peak, start, Math.min(0.006, length / 4), length);
  source.connect(filter);
  filter.connect(gain);
  // A random spot in the buffer, so ten shots in a row are not ten copies of one click.
  source.start(start, Math.random() * 0.5);
  source.stop(start + length + 0.02);
  source.onended = () => {
    source.disconnect();
    filter.disconnect();
    gain.disconnect();
  };
}

/** A struck bell: the note, and the partial at 2.7 times it that stops it sounding like an organ. */
function bell(ctx: AudioContext, to: AudioNode, hz: number, start: number, length: number, peak: number): void {
  tone(ctx, to, "sine", hz, hz, start, length, peak);
  tone(ctx, to, "sine", hz * 2.7, hz * 2.7, start, length * 0.55, peak * 0.4);
}

/**
 * The palette. Every entry returns how long it runs, in seconds, so a positional sound
 * knows when its panner can be let go. Nothing is longer than 400 ms.
 */
const SOUNDS: Record<Sfx, (ctx: AudioContext, to: AudioNode, at: number) => number> = {
  shot: (ctx, to, at) => {
    tone(ctx, to, "sine", 900, 200, at, 0.09, 0.22);
    noise(ctx, to, at, 0.02, 0.1, 4200, 2200);
    return 0.09;
  },
  hit: (ctx, to, at) => {
    tone(ctx, to, "square", 1200, 1200, at, 0.06, 0.15);
    return 0.06;
  },
  kill: (ctx, to, at) => {
    noise(ctx, to, at, 0.35, 0.2, 4000, 200);
    tone(ctx, to, "sine", 90, 45, at, 0.22, 0.18);
    return 0.35;
  },
  boltIncoming: (ctx, to, at) => {
    tone(ctx, to, "sawtooth", 300, 700, at, 0.2, 0.14);
    return 0.2;
  },
  shieldHit: (ctx, to, at) => {
    tone(ctx, to, "sine", 120, 70, at, 0.22, 0.26);
    noise(ctx, to, at, 0.04, 0.09, 1400, 700);
    return 0.22;
  },
  downed: (ctx, to, at) => {
    tone(ctx, to, "triangle", 392, 330, at, 0.15, 0.2);
    tone(ctx, to, "triangle", 262, 196, at + 0.15, 0.19, 0.2);
    return 0.34;
  },
  respawn: (ctx, to, at) => {
    tone(ctx, to, "triangle", 262, 330, at, 0.15, 0.18);
    tone(ctx, to, "triangle", 392, 523, at + 0.15, 0.19, 0.18);
    return 0.34;
  },
  spawn: (ctx, to, at) => {
    tone(ctx, to, "triangle", 180, 420, at, 0.18, 0.12);
    return 0.18;
  },
  pickup: (ctx, to, at) => {
    tone(ctx, to, "triangle", 659, 659, at, 0.07, 0.16);
    tone(ctx, to, "triangle", 831, 831, at + 0.08, 0.07, 0.16);
    return 0.15;
  },
  deliver: (ctx, to, at) => {
    tone(ctx, to, "triangle", 523, 523, at, 0.07, 0.16);
    tone(ctx, to, "triangle", 659, 659, at + 0.08, 0.07, 0.16);
    return 0.15;
  },
  landmark: (ctx, to, at) => {
    bell(ctx, to, 880, at, 0.38, 0.14);
    return 0.38;
  },
  questDone: (ctx, to, at) => {
    tone(ctx, to, "triangle", 523, 523, at, 0.11, 0.18);
    tone(ctx, to, "triangle", 659, 659, at + 0.09, 0.11, 0.18);
    tone(ctx, to, "triangle", 784, 784, at + 0.18, 0.12, 0.18);
    return 0.3;
  },
  paid: (ctx, to, at) => {
    const notes = [523, 659, 784, 1047];
    notes.forEach((hz, step) => tone(ctx, to, "triangle", hz, hz, at + step * 0.085, 0.12, 0.2));
    return 0.375;
  },
  tap: (ctx, to, at) => {
    tone(ctx, to, "sine", 1800, 1800, at, 0.02, 0.08);
    return 0.02;
  },
  assist: (ctx, to, at) => {
    bell(ctx, to, 1175, at, 0.3, 0.1);
    return 0.3;
  },
  refused: (ctx, to, at) => {
    tone(ctx, to, "square", 90, 70, at, 0.08, 0.16);
    return 0.08;
  },
};

function whiteNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return buffer;
}

/** Brown noise: white with the top taken off by integration. It reads as distance, not static. */
function brownNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < data.length; index += 1) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[index] = last * 3.4;
  }
  return buffer;
}
