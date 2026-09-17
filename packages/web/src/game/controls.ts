/**
 * Two thumbs. The left half of the screen is a stick that appears wherever the thumb
 * lands, the right half turns the camera, and the button in the corner fires. A desktop
 * gets WASD, a mouse drag and the space bar so the same build can be tested without a
 * phone in hand.
 *
 * Nothing here decides what happens in the world. It turns gestures into the two intents
 * the server accepts: a direction to walk, and a direction to shoot.
 *
 * Every pointer that goes down is given a job and kept in a map by its id. A WebView that
 * swallows a pointerup, or hands the same id on to a second finger, is why the stick used
 * to stay lit with the body walking off on its own: only the id that went up is ever
 * released, and a stick that stops reporting while it still holds a direction is checked
 * against the browser's own capture and let go.
 */

const STICK_RADIUS = 56;
const DEAD_ZONE = 8;

/** A drag across the whole screen is one full turn. */
const TURN_PER_SCREEN = Math.PI * 2;
const PITCH_PER_SCREEN = 1.2;
const PITCH_MIN = -0.35;

/**
 * How far up the camera may tilt. An engaged drone closes to about six metres and hangs six
 * metres up, which is 36 degrees above the eye, and the old ceiling of 0.6 rad put the thing
 * shooting at you above the top of the screen with no way to look at it.
 */
const PITCH_MAX = 0.9;

/** A look drag has to travel this far before it turns anything, so a tap is never a turn. */
const LOOK_DEAD_ZONE = 3;

/**
 * The most one pointer event may turn the view. A pointer id handed on to a second finger
 * reports the jump between two thumbs as a single move, and without this the street spins.
 */
const MAX_DRAG_PX = 140;

/** How long the published yaw takes to settle onto the raw drag. */
const YAW_SETTLE_MS = 60;

/**
 * The socket budget is twenty move intents a second, and timer jitter used to push a
 * nominal eighteen over it. Sends are counted off their own slot rather than off the
 * wakeup, so the rate is a hard fifteen a second whatever the timer does, and every
 * intent stays short enough that the replay in world.ts can reproduce it in one step.
 */
const MOVE_EVERY_MS = 70;
const MOVE_POLL_MS = 20;

/** A move intent is resent this often even when nothing changed, so the server never ages it out. */
const KEEPALIVE_MS = 500;

/** A stick that holds a direction this long without a single pointermove is suspect. */
const STALE_STICK_MS = 1500;
const STALE_POLL_MS = 250;

/** A mouse press that travels further than this was a look, not a shot. */
const CLICK_SLOP = 4;

const ACCENT = "#ff6a2b";

const dev = process.env.NODE_ENV !== "production";

export type MoveIntent = { dx: number; dz: number; yaw: number };

/** A move intent with the number the server will echo back once it has applied it. */
export type SentMove = MoveIntent & { seq: number };

export type ControlsOptions = {
  surface: HTMLElement;
  onMove: (move: SentMove) => void;
  onFire: (yaw: number, pitch: number) => void;
  /** Milliseconds between shots while the trigger is held, read from the player's gear. */
  fireIntervalMs: () => number;
  onFirstStick?: () => void;
};

export type Controls = {
  /** Where the player is looking, read by the camera and the crosshair every frame. */
  look: () => { yaw: number; pitch: number };
  /**
   * The thumb as it is right now, turned into a world direction. The world reads this on
   * every rendered frame, so the body walks at the refresh rate instead of at the rate
   * intents go out.
   */
  move: () => MoveIntent;
  /** Binds the HUD's fire button, so the repeat while held lives in one place. */
  attachFire: (button: HTMLElement) => () => void;
  /**
   * Puts the move counter back where a room says it is. A reconnect starts the server's
   * count again at zero, so a client that kept counting would send numbers the server has
   * never seen and the world would replay every unacknowledged intent before catching up.
   */
  resetSequence: (seq: number) => void;
  dispose: () => void;
};

type Role = "stick" | "look" | "fire";

type Stick = {
  pointer: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  movedAt: number;
};

type Look = { pointer: number; x: number; y: number; travelled: number; mouse: boolean };

function ringElement(): HTMLDivElement {
  const ring = document.createElement("div");
  ring.style.cssText = [
    "position:absolute",
    "width:132px",
    "height:132px",
    "margin:-66px 0 0 -66px",
    "border-radius:9999px",
    "border:1px solid rgba(243,239,231,0.22)",
    "background:radial-gradient(circle, rgba(243,239,231,0.07) 0%, rgba(243,239,231,0) 70%)",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity 160ms ease",
    "will-change:transform,opacity",
  ].join(";");
  return ring;
}

function knobElement(): HTMLDivElement {
  const knob = document.createElement("div");
  knob.style.cssText = [
    "position:absolute",
    "width:54px",
    "height:54px",
    "margin:-27px 0 0 -27px",
    "border-radius:9999px",
    `border:1px solid ${ACCENT}`,
    "background:rgba(255,106,43,0.18)",
    "box-shadow:0 0 24px rgba(255,106,43,0.35)",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity 160ms ease",
    "will-change:transform,opacity",
  ].join(";");
  return knob;
}

function clampDrag(value: number): number {
  return value > MAX_DRAG_PX ? MAX_DRAG_PX : value < -MAX_DRAG_PX ? -MAX_DRAG_PX : value;
}

export function createControls(options: ControlsOptions): Controls {
  const { surface } = options;

  const ring = ringElement();
  const knob = knobElement();
  surface.append(ring, knob);

  /** What each pointer that is down is for. The only thing a release is allowed to read. */
  const roles = new Map<number, Role>();

  let yawTarget = 0;
  let yaw = 0;
  let yawAt = 0;
  let pitch = 0.08;
  let stick: Stick | null = null;
  let look: Look | null = null;
  let firstStickDone = false;

  const keys = new Set<string>();

  let firing = false;
  let nextShotAt = 0;
  let trigger: ReturnType<typeof setInterval> | null = null;

  let lastSent: MoveIntent = { dx: 0, dz: 0, yaw: 0 };
  let lastSentAt = 0;
  let nextSendAt = 0;
  let sequence = 0;

  /** The published yaw eases onto the drag, which is what takes the step out of a turn. */
  function settleYaw(): void {
    const now = performance.now();
    const dt = yawAt === 0 ? 0 : Math.min(0.1, (now - yawAt) / 1000);
    yawAt = now;
    if (dt <= 0) return;
    let gap = yawTarget - yaw;
    while (gap > Math.PI) gap -= Math.PI * 2;
    while (gap < -Math.PI) gap += Math.PI * 2;
    yaw += gap * (1 - Math.exp((-dt * 1000 * 3) / YAW_SETTLE_MS));
  }

  function paintStick(): void {
    if (!stick) {
      ring.style.opacity = "0";
      knob.style.opacity = "0";
      return;
    }
    const rect = surface.getBoundingClientRect();
    const originX = stick.originX - rect.left;
    const originY = stick.originY - rect.top;
    let dx = stick.x - stick.originX;
    let dy = stick.y - stick.originY;
    const length = Math.hypot(dx, dy);
    if (length > STICK_RADIUS) {
      dx = (dx / length) * STICK_RADIUS;
      dy = (dy / length) * STICK_RADIUS;
    }
    ring.style.transform = `translate3d(${originX}px, ${originY}px, 0)`;
    knob.style.transform = `translate3d(${originX + dx}px, ${originY + dy}px, 0)`;
    ring.style.opacity = "1";
    knob.style.opacity = "1";
  }

  /** The stick, turned into a world direction relative to where the camera is looking. */
  function stickVector(): { forward: number; right: number } {
    if (!stick) return { forward: 0, right: 0 };
    const dx = stick.x - stick.originX;
    const dy = stick.y - stick.originY;
    const length = Math.hypot(dx, dy);
    if (length < DEAD_ZONE) return { forward: 0, right: 0 };
    return { forward: -dy / length, right: dx / length };
  }

  function keyVector(): { forward: number; right: number } {
    const forward = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
    const right = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
    const length = Math.hypot(forward, right);
    if (length === 0) return { forward: 0, right: 0 };
    return { forward: forward / length, right: right / length };
  }

  function intent(): MoveIntent {
    const thumb = stickVector();
    const board = keyVector();
    const forward = thumb.forward !== 0 || thumb.right !== 0 ? thumb.forward : board.forward;
    const right = thumb.forward !== 0 || thumb.right !== 0 ? thumb.right : board.right;
    if (forward === 0 && right === 0) return { dx: 0, dz: 0, yaw };

    // The server normalises the vector it is sent, so the client predicts with a unit
    // vector too: a half pushed stick walks at the same speed as a full one.
    // Screen right is forward x up: (-cos yaw, sin yaw). With the other sign the stick
    // walked mirrored, which Ram caught on his phone.
    const dx = forward * Math.sin(yaw) - right * Math.cos(yaw);
    const dz = forward * Math.cos(yaw) + right * Math.sin(yaw);
    const length = Math.hypot(dx, dz);
    return { dx: dx / length, dz: dz / length, yaw };
  }

  function dropStick(why: string): void {
    if (!stick) return;
    if (dev) console.warn(`[vettai] stick pointer ${stick.pointer} let go: ${why}`);
    stick = null;
    paintStick();
  }

  /** Lets go of one pointer id, and only that id. */
  function release(pointerId: number): void {
    roles.delete(pointerId);
    if (stick && stick.pointer === pointerId) {
      stick = null;
      paintStick();
    }
    if (look && look.pointer === pointerId) look = null;
  }

  function stopFiring(): void {
    firing = false;
    if (trigger !== null) clearInterval(trigger);
    trigger = null;
  }

  function releaseAll(): void {
    roles.clear();
    stick = null;
    look = null;
    paintStick();
    keys.clear();
    stopFiring();
  }

  const mover = setInterval(() => {
    const now = performance.now();
    if (now < nextSendAt) return;
    nextSendAt = nextSendAt + MOVE_EVERY_MS;
    if (nextSendAt < now) nextSendAt = now + MOVE_EVERY_MS;

    const next = intent();
    const still = next.dx === 0 && next.dz === 0;
    const same =
      Math.abs(next.dx - lastSent.dx) < 0.01 &&
      Math.abs(next.dz - lastSent.dz) < 0.01 &&
      Math.abs(next.yaw - lastSent.yaw) < 0.01;

    // A pushed stick goes out every slot even when the direction has not changed. The
    // server keeps applying the last intent it holds, so one intent left standing for
    // half a second is half a second the client cannot replay accurately.
    if (still && same && now - lastSentAt < KEEPALIVE_MS) return;

    lastSent = next;
    lastSentAt = now;
    sequence += 1;
    options.onMove({ seq: sequence, ...next });
  }, MOVE_POLL_MS);

  /**
   * A stick that has held a direction for a second and a half without one pointermove is
   * either a thumb resting dead still or a pointer the WebView has quietly thrown away.
   * The browser's own capture tells the two apart: a real thumb still holds it.
   */
  const staleWatch = setInterval(() => {
    if (!stick) return;
    const pushed = stickVector();
    if (pushed.forward === 0 && pushed.right === 0) return;
    if (performance.now() - stick.movedAt < STALE_STICK_MS) return;
    if (typeof navigator.maxTouchPoints !== "number") return;
    if (roles.get(stick.pointer) !== "stick") {
      dropStick("it is no longer a live pointer");
      return;
    }

    let held = true;
    try {
      held = surface.hasPointerCapture(stick.pointer);
    } catch {
      held = false;
    }
    if (held) return;
    roles.delete(stick.pointer);
    dropStick("the browser dropped its capture");
  }, STALE_POLL_MS);

  function shoot(): void {
    const now = performance.now();
    if (now < nextShotAt) return;
    nextShotAt = now + options.fireIntervalMs();
    settleYaw();
    options.onFire(yaw, pitch);
  }

  function startFiring(): void {
    if (firing) return;
    firing = true;
    shoot();
    trigger = setInterval(() => {
      if (firing) shoot();
    }, 40);
  }

  /** Capture keeps a thumb that slides off the element still driving it. */
  function capture(element: HTMLElement, pointerId: number): void {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // A pointer that is no longer down cannot be captured, which is not worth a failure.
    }
  }

  function onPointerDown(event: PointerEvent): void {
    const rect = surface.getBoundingClientRect();
    const left = event.clientX - rect.left < rect.width / 2;
    const role: Role = left && event.pointerType !== "mouse" ? "stick" : "look";

    // A second finger on the same half does not take the job over: the first one keeps it.
    if (role === "stick" && stick !== null && stick.pointer !== event.pointerId) return;
    if (role === "look" && look !== null && look.pointer !== event.pointerId) return;

    roles.set(event.pointerId, role);
    capture(surface, event.pointerId);

    if (role === "stick") {
      stick = {
        pointer: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        movedAt: performance.now(),
      };
      if (!firstStickDone) {
        firstStickDone = true;
        options.onFirstStick?.();
      }
      paintStick();
      return;
    }

    look = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      travelled: 0,
      mouse: event.pointerType === "mouse",
    };
  }

  function onPointerMove(event: PointerEvent): void {
    const role = roles.get(event.pointerId);
    if (role === undefined) return;

    if (role === "stick") {
      if (!stick || stick.pointer !== event.pointerId) return;
      stick.x = event.clientX;
      stick.y = event.clientY;
      stick.movedAt = performance.now();
      paintStick();
      return;
    }
    if (role !== "look" || !look || look.pointer !== event.pointerId) return;

    const rect = surface.getBoundingClientRect();
    const dx = clampDrag(event.clientX - look.x);
    const dy = clampDrag(event.clientY - look.y);
    look.x = event.clientX;
    look.y = event.clientY;
    const before = look.travelled;
    const size = Math.abs(dx) + Math.abs(dy);
    look.travelled += size;
    if (look.travelled < LOOK_DEAD_ZONE) return;

    // Only the part of the first move beyond the dead zone turns the view. Dropping the
    // whole event instead would throw a fast flick away, since a flick can arrive as one
    // big pointermove rather than a stream of small ones.
    let turnX = dx;
    let turnY = dy;
    if (before < LOOK_DEAD_ZONE && size > 0) {
      const share = (look.travelled - LOOK_DEAD_ZONE) / size;
      turnX = dx * share;
      turnY = dy * share;
    }

    yawTarget += (turnX / Math.max(1, rect.width)) * TURN_PER_SCREEN;
    pitch -= (turnY / Math.max(1, rect.height)) * PITCH_PER_SCREEN;
    pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch));
  }

  function onPointerUp(event: PointerEvent): void {
    const role = roles.get(event.pointerId);
    const tap =
      role === "look" &&
      look !== null &&
      look.pointer === event.pointerId &&
      look.mouse &&
      look.travelled < CLICK_SLOP;
    release(event.pointerId);
    if (tap) shoot();
  }

  function onLostCapture(event: PointerEvent): void {
    // A WebView that takes the capture away is not going to send the pointerup either.
    release(event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === " ") {
      event.preventDefault();
      startFiring();
      return;
    }
    if ("wasd".includes(key)) keys.add(key);
  }

  function onKeyUp(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === " ") return stopFiring();
    keys.delete(key);
  }

  function onBlur(): void {
    releaseAll();
  }

  function onVisibility(): void {
    if (document.hidden) releaseAll();
  }

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", onPointerUp);
  surface.addEventListener("pointercancel", onPointerUp);
  surface.addEventListener("lostpointercapture", onLostCapture);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    look: () => {
      settleYaw();
      return { yaw, pitch };
    },

    move: () => {
      settleYaw();
      return intent();
    },

    resetSequence(seq) {
      sequence = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
      lastSent = { dx: 0, dz: 0, yaw: 0 };
      lastSentAt = 0;
    },

    attachFire(button: HTMLElement) {
      const down = (event: PointerEvent) => {
        event.preventDefault();
        roles.set(event.pointerId, "fire");
        capture(button, event.pointerId);
        startFiring();
      };
      const up = (event: PointerEvent) => {
        roles.delete(event.pointerId);
        stopFiring();
      };

      button.addEventListener("pointerdown", down);
      button.addEventListener("pointerup", up);
      button.addEventListener("pointercancel", up);
      button.addEventListener("lostpointercapture", up);

      return () => {
        button.removeEventListener("pointerdown", down);
        button.removeEventListener("pointerup", up);
        button.removeEventListener("pointercancel", up);
        button.removeEventListener("lostpointercapture", up);
      };
    },

    dispose() {
      clearInterval(mover);
      clearInterval(staleWatch);
      stopFiring();
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerUp);
      surface.removeEventListener("lostpointercapture", onLostCapture);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      ring.remove();
      knob.remove();
    },
  };
}
