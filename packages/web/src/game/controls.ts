/**
 * Two thumbs. The left half of the screen is a stick that appears wherever the thumb
 * lands, the right half turns the camera, and the button in the corner fires. A desktop
 * gets WASD, a mouse drag and the space bar so the same build can be tested without a
 * phone in hand.
 *
 * Nothing here decides what happens in the world. It turns gestures into the two intents
 * the server accepts: a direction to walk, and a direction to shoot.
 */

const STICK_RADIUS = 56;
const DEAD_ZONE = 8;

/** A drag across the whole screen is one full turn. */
const TURN_PER_SCREEN = Math.PI * 2;
const PITCH_PER_SCREEN = 1.2;
const PITCH_MIN = -0.35;
const PITCH_MAX = 0.6;

/**
 * The socket budget is twenty move intents a second. Sending a little under that leaves
 * room for timer jitter, and it keeps every intent short enough that the replay in
 * world.ts can reproduce it in one step.
 */
const MOVE_EVERY_MS = 55;

/** A move intent is resent this often even when nothing changed, so the server never ages it out. */
const KEEPALIVE_MS = 500;

/** A mouse press that travels further than this was a look, not a shot. */
const CLICK_SLOP = 4;

const ACCENT = "#ff6a2b";

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
  /** Binds the HUD's fire button, so the repeat while held lives in one place. */
  attachFire: (button: HTMLElement) => () => void;
  dispose: () => void;
};

type Stick = { pointer: number; originX: number; originY: number; x: number; y: number };

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

export function createControls(options: ControlsOptions): Controls {
  const { surface } = options;

  const ring = ringElement();
  const knob = knobElement();
  surface.append(ring, knob);

  let yaw = 0;
  let pitch = 0.08;
  let stick: Stick | null = null;
  let firstStickDone = false;

  const keys = new Set<string>();
  let look: { pointer: number; x: number; y: number; travelled: number; mouse: boolean } | null = null;

  let firing = false;
  let nextShotAt = 0;
  let trigger: ReturnType<typeof setInterval> | null = null;

  let lastSent: MoveIntent = { dx: 0, dz: 0, yaw: 0 };
  let lastSentAt = 0;
  let sequence = 0;

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
    const dx = forward * Math.sin(yaw) + right * Math.cos(yaw);
    const dz = forward * Math.cos(yaw) - right * Math.sin(yaw);
    const length = Math.hypot(dx, dz);
    return { dx: dx / length, dz: dz / length, yaw };
  }

  const mover = setInterval(() => {
    const now = performance.now();
    const next = intent();
    const still = next.dx === 0 && next.dz === 0;
    const same =
      Math.abs(next.dx - lastSent.dx) < 0.01 &&
      Math.abs(next.dz - lastSent.dz) < 0.01 &&
      Math.abs(next.yaw - lastSent.yaw) < 0.01;

    // A pushed stick goes out every tick even when the direction has not changed. The
    // server keeps applying the last intent it holds, so one intent left standing for
    // half a second is half a second the client cannot replay accurately.
    if (still && same && now - lastSentAt < KEEPALIVE_MS) return;

    lastSent = next;
    lastSentAt = now;
    sequence += 1;
    options.onMove({ seq: sequence, ...next });
  }, MOVE_EVERY_MS);

  function shoot(): void {
    const now = performance.now();
    if (now < nextShotAt) return;
    nextShotAt = now + options.fireIntervalMs();
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

  function stopFiring(): void {
    firing = false;
    if (trigger !== null) clearInterval(trigger);
    trigger = null;
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
    capture(surface, event.pointerId);

    if (left && event.pointerType !== "mouse") {
      stick = {
        pointer: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        x: event.clientX,
        y: event.clientY,
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
    if (stick && event.pointerId === stick.pointer) {
      stick.x = event.clientX;
      stick.y = event.clientY;
      paintStick();
      return;
    }
    if (!look || event.pointerId !== look.pointer) return;

    const rect = surface.getBoundingClientRect();
    const dx = event.clientX - look.x;
    const dy = event.clientY - look.y;
    look.x = event.clientX;
    look.y = event.clientY;
    look.travelled += Math.abs(dx) + Math.abs(dy);

    yaw += (dx / Math.max(1, rect.width)) * TURN_PER_SCREEN;
    pitch -= (dy / Math.max(1, rect.height)) * PITCH_PER_SCREEN;
    pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch));
  }

  function onPointerUp(event: PointerEvent): void {
    if (stick && event.pointerId === stick.pointer) {
      stick = null;
      paintStick();
      return;
    }
    if (!look || event.pointerId !== look.pointer) return;
    const tap = look.mouse && look.travelled < CLICK_SLOP;
    look = null;
    if (tap) shoot();
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
    keys.clear();
    stopFiring();
    stick = null;
    paintStick();
  }

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", onPointerUp);
  surface.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    look: () => ({ yaw, pitch }),

    attachFire(button: HTMLElement) {
      const down = (event: PointerEvent) => {
        event.preventDefault();
        capture(button, event.pointerId);
        startFiring();
      };
      const up = () => stopFiring();

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
      stopFiring();
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      ring.remove();
      knob.remove();
    },
  };
}
