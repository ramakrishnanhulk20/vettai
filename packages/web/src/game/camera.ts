import * as THREE from "three";
import type { Box } from "./map";
import { segmentHitsBox } from "./slide";

/**
 * The camera that follows a player: over the shoulder, behind the head, and pulled in
 * when a wall would otherwise cut the shot. Yaw 0 looks along +z, the same convention the
 * server uses, so where the camera points is where the blaster fires.
 *
 * The boom is treated as a line from the head outwards. The line is walked until it
 * crosses a building, the camera sits just short of that crossing, and if there is not
 * even a metre and a bit of room left the shot goes overhead instead. Standing with your
 * back to a wall should never fill the screen with brick.
 */

/**
 * How far back and how high the camera sits. A portrait phone measures its field of view
 * vertically, so the same boom that frames a laptop shot fills a third of a phone screen
 * with the player's own back. Portrait stands further off and higher, and gets the street
 * back.
 */
const BOOM = 4.6;
const LIFT = 2.3;
const PORTRAIT_BOOM = 6;
const PORTRAIT_LIFT = 3.2;
const EYE = 1.5;

/** Where the shot is framed: chest height on the player, six metres down the street. */
const LOOK_HEIGHT = 1.4;
const LOOK_AHEAD = 6;

/** How far short of the wall the camera stops. */
const CLEARANCE = 0.3;

/** Under this much boom the over the shoulder shot is not worth having. */
const MIN_BOOM = 1.2;

/** The way out when there is no room behind the player: high up, looking down. */
const HIGH_LIFT = 3.5;
const HIGH_BACK = 1.2;

/** The shared list's radius when a caller does not say, in metres: the game's hitscan range. */
const DEFAULT_REACH = 60;

/** How many slices the head to camera line is walked in before the answer is narrowed. */
const MARCH = 12;

/** Fraction of the gap the camera closes each second. Higher is tighter, lower is floatier. */
const FOLLOW_RATE = 14;

/** How long a change in boom length, or a switch to the overhead shot, takes to settle. */
const SETTLE_MS = 120;

export type Blocker = { aabb: Box; height: number };

export type CameraRig = {
  update: (
    camera: THREE.PerspectiveCamera,
    at: { x: number; z: number },
    yaw: number,
    pitch: number,
    blockers: readonly Blocker[],
    deltaSeconds: number,
  ) => void;
  /**
   * The buildings within `reachMetres` of the player, as of the last update. The rig walks
   * the whole list once a frame to find its own handful, so anything else that needs to
   * ask about walls near the player reads this rather than walking the list again. It is
   * the live array, not a copy: read it, do not keep it.
   */
  inReach: () => readonly Blocker[];
  /** False until the first update, when nothing has been looked at yet. */
  scanned: () => boolean;
  /** Drops the camera straight onto its mark, for a spawn or a respawn. */
  snap: () => void;
};

function crosses(head: THREE.Vector3, spot: THREE.Vector3, blockers: readonly Blocker[]): boolean {
  for (const building of blockers) {
    if (segmentHitsBox(head, spot, building.aabb, 0, building.height)) return true;
  }
  return false;
}

/** True when the point sits in the solid part of a building rather than beside it. */
function inside(spot: THREE.Vector3, blockers: readonly Blocker[]): boolean {
  for (const building of blockers) {
    const box = building.aabb;
    if (
      spot.x > box.minX &&
      spot.x < box.maxX &&
      spot.z > box.minZ &&
      spot.z < box.maxZ &&
      spot.y < building.height
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param reachMetres how far out the shared blocker list goes. Anything asking about a
 * line from the player that is no longer than this can trust it, because a box the line
 * touches must lie within that distance of where the line starts.
 */
export function createCameraRig(reachMetres: number = DEFAULT_REACH): CameraRig {
  const head = new THREE.Vector3();
  const full = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const wanted = new THREE.Vector3();
  const overhead = new THREE.Vector3();
  const look = new THREE.Vector3();
  const back = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const nearby: Blocker[] = [];
  const withinReach: Blocker[] = [];

  let scanned = false;
  let boom = BOOM;
  /** Zero is the over the shoulder shot, one is looking down from above. */
  let high = 0;
  let placed = false;

  /** The free length of the head to camera line, walked coarsely then narrowed. */
  function freeReach(blockers: readonly Blocker[], climb: number, boomNow: number): number {
    if (!crosses(head, full, blockers)) return boomNow;

    let low = 0;
    let stop = boomNow;
    for (let slice = 1; slice <= MARCH; slice++) {
      const reach = (boomNow * slice) / MARCH;
      probe.copy(head).addScaledVector(back, reach);
      probe.y = EYE + climb * reach;
      if (crosses(head, probe, blockers)) {
        stop = reach;
        break;
      }
      low = reach;
    }

    for (let pass = 0; pass < 5; pass++) {
      const middle = (low + stop) / 2;
      probe.copy(head).addScaledVector(back, middle);
      probe.y = EYE + climb * middle;
      if (crosses(head, probe, blockers)) stop = middle;
      else low = middle;
    }
    return low;
  }

  return {
    update(camera, at, yaw, pitch, blockers, deltaSeconds) {
      const dt = Math.min(Math.max(deltaSeconds, 0), 0.1);
      head.set(at.x, EYE, at.z);

      const portrait = camera.aspect < 1;
      const wide = portrait ? PORTRAIT_BOOM : BOOM;
      const rise = portrait ? PORTRAIT_LIFT : LIFT;

      const flat = Math.cos(pitch);
      back.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      ahead.set(Math.sin(yaw) * flat, Math.sin(pitch), Math.cos(yaw) * flat);

      // Height is linear in boom length, so the head to camera line is straight and every
      // probe along it sits exactly where the camera would.
      const climb = rise / wide - Math.sin(pitch);
      full.copy(head).addScaledVector(back, wide);
      full.y = EYE + climb * wide;

      // One walk of the buildings a frame, filling two lists: the few the boom could hit,
      // and the wider set anything else this frame needs to ask about.
      // The shared list can never be narrower than the camera's own, whatever reach the
      // caller asked for, because the camera reads its list out of this one.
      const outer = Math.max(reachMetres, wide + 2);
      nearby.length = 0;
      withinReach.length = 0;
      for (const building of blockers) {
        const box = building.aabb;
        if (
          at.x > box.minX - outer &&
          at.x < box.maxX + outer &&
          at.z > box.minZ - outer &&
          at.z < box.maxZ + outer
        ) {
          withinReach.push(building);
        } else {
          continue;
        }
        if (
          at.x > box.minX - wide - 2 &&
          at.x < box.maxX + wide + 2 &&
          at.z > box.minZ - wide - 2 &&
          at.z < box.maxZ + wide + 2
        ) {
          nearby.push(building);
        }
      }
      scanned = true;

      const free =
        nearby.length === 0 ? wide : Math.max(0, freeReach(nearby, climb, wide) - CLEARANCE);
      const wantHigh = free < MIN_BOOM ? 1 : 0;

      const settle = 1 - Math.exp((-dt * 1000 * 3) / SETTLE_MS);
      boom += (Math.max(free, MIN_BOOM) - boom) * settle;
      high += (wantHigh - high) * settle;
      if (!placed) {
        boom = Math.max(free, MIN_BOOM);
        high = wantHigh;
      }

      // The easing lags behind a wall that has just arrived, so the length is clipped to
      // what is really free. Only coming back out is ever smoothed.
      const reach = Math.min(boom, Math.max(free, 0));

      wanted.copy(head).addScaledVector(back, reach);
      wanted.y = EYE + climb * reach;

      overhead.copy(head).addScaledVector(back, HIGH_BACK);
      overhead.y = EYE + HIGH_LIFT;

      wanted.lerp(overhead, high);

      // The last word: a camera that would still be in the brick goes overhead whatever
      // the easing says, because a screen full of wall is not a game. Stood right against
      // a face, even the metre behind is inside it, so the shot swings over the street in
      // front instead, and only then straight down.
      if (inside(wanted, nearby)) wanted.copy(overhead);
      if (inside(wanted, nearby)) {
        wanted.set(head.x + ahead.x * HIGH_BACK, EYE + HIGH_LIFT, head.z + ahead.z * HIGH_BACK);
      }
      if (inside(wanted, nearby)) wanted.set(head.x, EYE + HIGH_LIFT, head.z);

      // Easing toward a spot in front of a wall would walk the camera through the wall on
      // the way, so a jump is taken in one frame and only the follow is smoothed.
      const jumped = wanted.distanceTo(camera.position) > wide;
      if (!placed || jumped || high > 0.5) {
        camera.position.copy(wanted);
        placed = true;
      } else {
        camera.position.lerp(wanted, Math.min(1, FOLLOW_RATE * dt));
        if (inside(camera.position, nearby)) camera.position.copy(wanted);
      }

      // From overhead the shot is framed on the player themself, not down the street, or
      // they would sit at the bottom edge of a screen full of dark road.
      look.set(at.x, LOOK_HEIGHT, at.z).addScaledVector(ahead, LOOK_AHEAD * (1 - high));
      camera.lookAt(look);
    },

    inReach: () => withinReach,

    scanned: () => scanned,

    snap() {
      // Boom is worked out from scratch on the next frame, which is where the shape of the
      // screen is known, so nothing is guessed here.
      placed = false;
      high = 0;
    },
  };
}
