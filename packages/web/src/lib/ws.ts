import { getTicket, type Gear, type QuestView } from "./api";

/**
 * The play socket.
 *
 * Every frame carries `v: 1`. The client sends intents and nothing else: where the thumb
 * is pushing and when the trigger is down. Where the player ends up, what was hit and what
 * a quest says all come back from the server.
 */

export const PROTOCOL_VERSION = 1;

export type PlayerWire = {
  id: string;
  x: number;
  z: number;
  yaw: number;
  shield: number;
  downed: boolean;
  gear: Gear;
  /**
   * The highest `move` sequence number the server has applied for this player, 0 before
   * any. The client rewinds to `x, z` and replays only the intents above this. A frame
   * without it comes from a server that does not echo yet, and is read as "all applied".
   */
  seq?: number;
};

export type DroneWire = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  state: "patrol" | "engage" | "dead";
};

export type BoltWire = { id: string; x: number; y: number; z: number };

export type TickEvent =
  | { kind: "hit"; player: string; drone: string; damage: number; x: number; y: number; z: number }
  | { kind: "kill"; player: string; drone: string; x: number; y: number; z: number }
  | { kind: "droneHit"; player: string; drone: string; damage: number; x: number; y: number; z: number }
  | { kind: "downed"; player: string; x: number; y: number; z: number }
  | { kind: "respawn"; player: string; x: number; y: number; z: number }
  | { kind: "spawn"; drone: string; x: number; y: number; z: number }
  | { kind: "pickup"; player: string; point: number }
  | { kind: "deliver"; player: string; point: number }
  | { kind: "landmark"; player: string; index: number }
  /** Your shot finished a drone somebody else had done most of the damage to. */
  | { kind: "assist"; drone: string }
  /** The parcel is back at its pickup point: it went cold, or the day turned over. */
  | { kind: "courier-reset"; reason: "cold" | "day" }
  /** Midnight UTC passed while this player was in the city, and today's jobs are new. */
  | { kind: "quests-rolled" };

/**
 * Who the room says you are. A world that names players by their wallet sends the address
 * as a plain string; one that hands out opaque handles sends both. Either way the id here
 * is the one the players list uses, and it is the only place the client learns it.
 */
export type WelcomeYou = string | { address: string; handle?: string };

export function youOf(frame: { you: WelcomeYou }): string {
  const you = frame.you;
  if (typeof you === "string") return you;
  return you.handle ?? you.address;
}

export type WelcomeFrame = {
  t: "welcome";
  you: WelcomeYou;
  room: string;
  tick: number;
  mapVersion: string;
  players: PlayerWire[];
  drones: DroneWire[];
  quests: QuestView[];
};

export type StateFrame = {
  t: "state";
  tick: number;
  players: PlayerWire[];
  drones: DroneWire[];
  bolts: BoltWire[];
  events: TickEvent[];
};

/**
 * The per-player frames. A refused message (`{ t: 'error', code }`) rides this channel as
 * `kind: 'error'` so one listener covers everything the server says about this player.
 */
export type EventFrame =
  | { t: "event"; kind: "quest"; quest: QuestView }
  | { t: "event"; kind: "gear"; item: string; gear: Gear }
  | { t: "event"; kind: "interact"; target: string }
  | { t: "event"; kind: "join"; player: string }
  | { t: "event"; kind: "leave"; player: string }
  | { t: "event"; kind: "error"; code: string };

export type PongFrame = { t: "pong"; ts: number; serverTs: number };

export type CloseFrame = {
  willRetry: boolean;
  reason: string;
  /** The WebSocket close code, when the browser gave us one. */
  code?: number;
  /** True when this socket is never coming back on its own and a person has to act. */
  fatal?: boolean;
};

export type ClientFrame =
  | { t: "move"; seq?: number; dx: number; dz: number; yaw: number }
  | { t: "fire"; seq?: number; yaw: number; pitch: number }
  | { t: "interact"; target: string }
  | { t: "ping"; ts: number };

type Channels = {
  welcome: WelcomeFrame;
  state: StateFrame;
  event: EventFrame;
  pong: PongFrame;
  close: CloseFrame;
};

export type WorldConnection = {
  send: (frame: ClientFrame) => void;
  on: <K extends keyof Channels>(kind: K, handler: (frame: Channels[K]) => void) => () => void;
  /** Round trip in milliseconds from the last pong, or null before the first one. */
  latency: () => number | null;
  close: () => void;
};

const PING_EVERY_MS = 5000;

/** 1, 2, 4, 8 seconds, then every 15. A phone that walked into a lift comes back on its own. */
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const BACKOFF_CAP_MS = 15000;

/** After this many goes without ever getting a welcome, retrying is not the answer. */
const MAX_ATTEMPTS = 8;

/** Three server faults in a row is the world saying it cannot have us, not a bad line. */
const MAX_SERVER_FAULTS = 3;

/**
 * Close codes the world only sends when it has decided about this client: 1008 is a
 * refusal (a spent ticket, a rate limit, a protocol breach) and 1003 is a frame it will
 * not read. Coming straight back with the same client would get the same answer.
 */
const FATAL_CODES = new Set([1003, 1008]);

function closeReason(code: number | undefined, given: string): string {
  if (code === 1008) return given || "the world refused this connection";
  if (code === 1003) return given || "the world could not read what this game sent";
  if (code === 1011) return given || "the world server hit a fault";
  return given || "the socket closed";
}

function socketUrl(ticket: string, base: string | null): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const root = base ?? `${scheme}://${window.location.host}/ws`;
  return `${root}?ticket=${encodeURIComponent(ticket)}`;
}

function backoff(attempt: number): number {
  return BACKOFF_MS[attempt] ?? BACKOFF_CAP_MS;
}

/** True while this page is not the one on screen: another tab, or a phone taking a call. */
function away(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

const dev = process.env.NODE_ENV !== "production";

/**
 * Opens the world socket with a ticket that was already fetched, and keeps it open. A
 * dropped socket is reconnected on its own with a fresh ticket, because a ticket is spent
 * the moment it is used and lives one minute.
 *
 * A page nobody is looking at gets different treatment. Its timers are throttled to about
 * one a minute, so a backoff running behind a phone call used to burn every retry the cap
 * allows and leave a stopped game on screen when the player came back. While the page is
 * away nothing is retried and nothing is counted: the socket comes back the moment the
 * player does, on the visibility event rather than on a timer.
 */
export function connectWorld(ticket: string): WorldConnection {
  const listeners: { [K in keyof Channels]: Set<(frame: Channels[K]) => void> } = {
    welcome: new Set(),
    state: new Set(),
    event: new Set(),
    pong: new Set(),
    close: new Set(),
  };

  let socket: WebSocket | null = null;
  let next: string | null = ticket;
  // Where the socket lives is learned from the ticket reply: on Vercel the web origin
  // cannot carry the upgrade, so the world names its own address.
  let base: string | null = null;
  let baseKnown = false;
  let attempt = 0;
  /** Consecutive 1011s. The world is faulting rather than this line being bad. */
  let faults = 0;
  let round: number | null = null;
  let closed = false;
  let pinger: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** True between asking for a ticket and having a socket, so two opens cannot race. */
  let opening = false;

  function emit<K extends keyof Channels>(kind: K, frame: Channels[K]): void {
    for (const handler of listeners[kind]) handler(frame);
  }

  function stopPings(): void {
    if (pinger !== null) clearInterval(pinger);
    pinger = null;
  }

  function giveUp(reason: string, code: number | undefined): void {
    closed = true;
    stopPings();
    stopWatching();
    if (retry !== null) clearTimeout(retry);
    retry = null;
    emit("close", { willRetry: false, reason, fatal: true, ...(code === undefined ? {} : { code }) });
  }

  function scheduleRetry(reason: string, code?: number): void {
    if (closed) return;

    if (code !== undefined && FATAL_CODES.has(code)) {
      return giveUp(closeReason(code, reason), code);
    }
    if (code === 1011) {
      faults += 1;
      if (faults >= MAX_SERVER_FAULTS) return giveUp(closeReason(code, reason), code);
    } else if (code !== undefined) {
      faults = 0;
    }
    if (attempt >= MAX_ATTEMPTS) {
      return giveUp("the world server did not answer after eight tries", code);
    }

    emit("close", { willRetry: true, reason, ...(code === undefined ? {} : { code }) });

    // Nobody is looking. A try made now would be throttled, would probably fail, and would
    // spend one of the eight the player needs when they come back, so the wait is the
    // visibility event instead of a timer.
    if (away()) return;

    const wait = backoff(attempt);
    attempt += 1;
    retry = setTimeout(() => {
      void open();
    }, wait);
  }

  /** Straight back in, with no backoff left to wait out. Used when the page comes back. */
  function reconnectNow(): void {
    if (closed || opening || socket !== null) return;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    void open();
  }

  function onVisibility(): void {
    if (away()) return;
    reconnectNow();
  }

  function stopWatching(): void {
    if (typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", onVisibility);
  }

  async function open(): Promise<void> {
    if (closed || opening || socket !== null) return;
    opening = true;

    if (next === null || !baseKnown) {
      const fresh = await getTicket();
      if (closed) {
        opening = false;
        return;
      }
      if (!fresh.ok) {
        opening = false;
        scheduleRetry(fresh.error);
        return;
      }
      next = fresh.data.ticket;
      base = (fresh.data as { wsUrl?: string | null }).wsUrl ?? null;
      baseKnown = true;
    }

    const live = new WebSocket(socketUrl(next, base));
    next = null;
    socket = live;
    opening = false;

    live.addEventListener("open", () => {
      // The retry count is not cleared here. A socket that upgrades and is then thrown
      // out is exactly the case the cap exists for; only a welcome proves we are in.
      stopPings();
      pinger = setInterval(() => {
        // A throttled wakeup on a hidden page carries a timestamp minutes old, which would
        // be read as a round trip of minutes. The beat is skipped rather than counted.
        if (away()) return;
        send({ t: "ping", ts: Date.now() });
      }, PING_EVERY_MS);
      send({ t: "ping", ts: Date.now() });
    });

    live.addEventListener("message", (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (typeof frame !== "object" || frame === null) return;

      const body = frame as { t?: string };
      if (body.t === "state") return emit("state", frame as StateFrame);
      if (body.t === "welcome") {
        attempt = 0;
        faults = 0;
        return emit("welcome", frame as WelcomeFrame);
      }
      if (body.t === "event") return emit("event", frame as EventFrame);
      if (body.t === "pong") {
        const pong = frame as PongFrame;
        round = Date.now() - pong.ts;
        return emit("pong", pong);
      }
      if (body.t === "error") {
        const refused = frame as { code?: string };
        return emit("event", { t: "event", kind: "error", code: refused.code ?? "refused" });
      }
    });

    live.addEventListener("close", (event) => {
      stopPings();
      if (socket !== live) return;
      socket = null;
      scheduleRetry(closeReason(event.code, event.reason), event.code);
    });

    live.addEventListener("error", () => {
      if (dev) console.warn("[vettai] the world socket errored");
    });
  }

  function send(frame: ClientFrame): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    if (dev && frame.t !== "move" && frame.t !== "ping") {
      console.info("[vettai] sent", JSON.stringify(frame));
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  void open();

  return {
    send,
    on(kind, handler) {
      const set = listeners[kind] as Set<(frame: Channels[typeof kind]) => void>;
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    latency: () => round,
    close() {
      closed = true;
      stopPings();
      stopWatching();
      if (retry !== null) clearTimeout(retry);
      const live = socket;
      socket = null;
      live?.close(1000, "left the game");
      emit("close", { willRetry: false, reason: "left the game", code: 1000 });
    },
  };
}
