import * as THREE from "three";
import type { Box } from "./map";
import { segmentHitsBox } from "./slide";

/**
 * The camera that follows a player: over the right shoulder height, behind the head, and
 * pulled in when a wall would otherwise cut the shot. Yaw 0 looks along +z, the same
 * convention the server uses, so where the camera points is where the blaster fires.
 */

const BOOM = 4.6;
const LIFT = 2.3;
const EYE = 1.5;

/** Where the shot is framed: chest height on the player, six metres down the street. */
const LOOK_HEIGHT = 1.4;
const LOOK_AHEAD = 6;

/** Nearest the camera may sit to the head before it would be inside it. */
const MIN_BOOM = 0.9;

/** How far in front of the boom a wall is looked for, so the pull-in starts early. */
const CLEARANCE = 0.35;

/** Fraction of the gap the camera closes each second. Higher is tighter, lower is floatier. */
const FOLLOW_RATE = 14;
const PULL_OUT_RATE = 3;

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
  /** Drops the camera straight onto its mark, for a spawn or a respawn. */
  snap: () => void;
};

function blocked(
  head: THREE.Vector3,
  spot: THREE.Vector3,
  blockers: readonly Blocker[],
): boolean {
  for (const building of blockers) {
    if (segmentHitsBox(head, spot, building.aabb, 0, building.height)) return true;
  }
  return false;
}

export function createCameraRig(): CameraRig {
  const head = new THREE.Vector3();
  const wanted = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const look = new THREE.Vector3();
  const nearby: Blocker[] = [];

  let boom = BOOM;
  let placed = false;

  return {
    update(camera, at, yaw, pitch, blockers, deltaSeconds) {
      const dt = Math.min(Math.max(deltaSeconds, 0), 0.1);
      head.set(at.x, EYE, at.z);

      const flat = Math.cos(pitch);
      const back = new THREE.Vector3(-Math.sin(yaw) * flat, -Math.sin(pitch), -Math.cos(yaw) * flat);

      nearby.length = 0;
      for (const building of blockers) {
        const box = building.aabb;
        if (
          at.x > box.minX - BOOM - 2 &&
          at.x < box.maxX + BOOM + 2 &&
          at.z > box.minZ - BOOM - 2 &&
          at.z < box.maxZ + BOOM + 2
        ) {
          nearby.push(building);
        }
      }

      let reach = BOOM;
      if (nearby.length > 0) {
        probe.copy(head).addScaledVector(back, BOOM + CLEARANCE);
        probe.y += LIFT;
        if (blocked(head, probe, nearby)) {
          let low = MIN_BOOM;
          let high = BOOM;
          for (let step = 0; step < 6; step++) {
            const middle = (low + high) / 2;
            probe.copy(head).addScaledVector(back, middle + CLEARANCE);
            probe.y += LIFT * (middle / BOOM);
            if (blocked(head, probe, nearby)) high = middle;
            else low = middle;
          }
          reach = low;
        }
      }

      // Snapping in is what keeps a wall out of the shot, so it happens at once; coming
      // back out is eased, or stepping past a corner would fling the camera.
      const pullingIn = reach < boom - 0.01;
      boom = pullingIn ? reach : boom + (reach - boom) * Math.min(1, PULL_OUT_RATE * dt);

      wanted.copy(head).addScaledVector(back, boom);
      wanted.y = EYE + LIFT * (boom / BOOM) - Math.sin(pitch) * boom;

      // Easing toward a spot in front of a wall would walk the camera through the wall on
      // the way, so a pull-in is taken in one frame and only the follow is smoothed.
      if (!placed || pullingIn) {
        camera.position.copy(wanted);
        placed = true;
      } else {
        camera.position.lerp(wanted, Math.min(1, FOLLOW_RATE * dt));
      }

      look
        .set(at.x, LOOK_HEIGHT, at.z)
        .addScaledVector(
          new THREE.Vector3(Math.sin(yaw) * flat, Math.sin(pitch), Math.cos(yaw) * flat),
          LOOK_AHEAD,
        );
      camera.lookAt(look);
    },

    snap() {
      placed = false;
      boom = BOOM;
    },
  };
}
