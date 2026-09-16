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
  | { kind: "landmark"; player: string; index: number };

export type WelcomeFrame = {
  t: "welcome";
  you: string;
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

export type CloseFrame = { willRetry: boolean; reason: string };

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

function socketUrl(ticket: string, base: string | null): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const root = base ?? `${scheme}://${window.location.host}/ws`;
  return `${root}?ticket=${encodeURIComponent(ticket)}`;
}

function backoff(attempt: number): number {
  return BACKOFF_MS[attempt] ?? BACKOFF_CAP_MS;
}

const dev = process.env.NODE_ENV !== "production";

/**
 * Opens the world socket with a ticket that was already fetched, and keeps it open. A
 * dropped socket is reconnected on its own with a fresh ticket, because a ticket is spent
 * the moment it is used and lives one minute.
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
  let round: number | null = null;
  let closed = false;
  let pinger: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function emit<K extends keyof Channels>(kind: K, frame: Channels[K]): void {
    for (const handler of listeners[kind]) handler(frame);
  }

  function stopPings(): void {
    if (pinger !== null) clearInterval(pinger);
    pinger = null;
  }

  function scheduleRetry(reason: string): void {
    if (closed) return;
    emit("close", { willRetry: true, reason });
    const wait = backoff(attempt);
    attempt += 1;
    retry = setTimeout(() => {
      void open();
    }, wait);
  }

  async function open(): Promise<void> {
    if (closed) return;

    if (next === null || !baseKnown) {
      const fresh = await getTicket();
      if (closed) return;
      if (!fresh.ok) {
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

    live.addEventListener("open", () => {
      attempt = 0;
      stopPings();
      pinger = setInterval(() => {
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
      if (body.t === "welcome") return emit("welcome", frame as WelcomeFrame);
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
      scheduleRetry(event.reason || "the socket closed");
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
      if (retry !== null) clearTimeout(retry);
      const live = socket;
      socket = null;
      live?.close(1000, "left the game");
      emit("close", { willRetry: false, reason: "left the game" });
    },
  };
}
