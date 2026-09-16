"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  getHealth,
  getTicket,
  getWorldMap,
  type ClaimView,
  type Gear,
  type QuestView,
} from "@/lib/api";
import { isUserRejection, waitForProvider } from "@/lib/nimiq";
import { login, me, readSession } from "@/lib/session";
import { connectWorld, type WorldConnection } from "@/lib/ws";
import { createControls, type Controls } from "@/game/controls";
import type { WorldMap } from "@/game/map";
import {
  chooseObjective,
  groundRange,
  metres,
  worldSpots,
  type MarkerSpot,
  type Objective,
} from "@/game/markers";
import { loadCityAssets, type CityAssets } from "@/game/scene/assets";
import { loadCharacters } from "@/game/scene/character";
import { createWorld, type Prompt, type World } from "@/game/world";
import Hud, { type Panel, type Toast } from "./Hud";
import Ladder from "./Ladder";
import QuestBoard from "./QuestBoard";
import Shop from "./Shop";
import { nim, type Network } from "./format";
import { useClaims } from "./useClaims";
import styles from "./play.module.css";

/**
 * The whole way in, as one machine: find the wallet, sign once, load the block, take a
 * seat in a room, play. Every wait says what is being waited for, and every dead end says
 * what to do next.
 */

type Phase =
  | { name: "provider" }
  | { name: "outside" }
  | { name: "signing" }
  | { name: "cancelled" }
  | { name: "loading"; percent: number }
  | { name: "connecting" }
  | { name: "playing" }
  | { name: "reconnecting" }
  | { name: "resigning" }
  | { name: "error"; title: string; body: string };

const PROVIDER_WAIT_MS = 15_000;
const HINT_KEY = "vettai.hint.stick";
const SHOP_KEY = "vettai.seen.shop";
const FIRST_MINUTE_KEY = "vettai.firstminute";
const TOAST_MS = 2600;

/** The parcel's window, the same two minutes COURIER_WINDOW_MS gives it on the server. */
const COURIER_WINDOW_MS = 120_000;

/** Four shots a second with the mk1 blaster, six with the mk2, as the simulation allows. */
const FIRE_INTERVAL: Record<Gear["blaster"], number> = { mk1: 250, mk2: 167 };

const CITY_STEPS = 20;
const CHARACTER_STEPS = 4;

const EASE = [0.16, 1, 0.3, 1] as const;

function questLabel(kind: QuestView["kind"]): string {
  if (kind === "hunt") return "Hunt";
  if (kind === "courier") return "Courier";
  if (kind === "landmarks") return "Landmarks";
  if (kind === "landlord") return "Landlord";
  return "Streak";
}

/** The nearest landmark this quest has not counted yet, in metres, or null when all are done. */
function nextLandmarkRange(map: WorldMap, quest: QuestView, at: { x: number; z: number }): number | null {
  let best: number | null = null;
  map.landmarks.forEach((place, index) => {
    if (quest.visited?.[index]) return;
    const range = groundRange(at, place);
    if (best === null || range < best) best = range;
  });
  return best;
}

/**
 * What a quest event says out loud. Every one of these ends on the next thing to do, so a
 * player is never told a number without being told where to take it.
 */
function questStep(quest: QuestView, map: WorldMap | null, at: { x: number; z: number } | null): string {
  const name = questLabel(quest.kind);

  if (quest.state !== "open") {
    const reward = nim(quest.rewardLuna);
    const money = reward === "0" ? "" : `${reward} NIM `;
    if (quest.kind === "courier") return `Delivered. ${money}ready at the office`;
    return `${name} complete. Claim ${money}at the office`;
  }

  if (quest.kind === "courier") {
    return quest.carrying === true
      ? "Parcel picked up. Deliver it in 2:00"
      : "The parcel went cold. Pick it up again";
  }

  if (quest.kind === "landmarks") {
    const reached = quest.visited?.filter(Boolean).length ?? quest.progress;
    const next = map && at ? nextLandmarkRange(map, quest, at) : null;
    const tail = next === null ? "" : ` Next one ${metres(next)}`;
    return `Landmark ${reached} of ${quest.target}.${tail}`;
  }

  if (quest.kind === "hunt") {
    const left = Math.max(0, quest.target - quest.progress);
    return left === 0 ? "Drone down" : `Drone down. ${left} more for the hunt`;
  }

  return `${name} ${quest.progress}/${quest.target}`;
}

function refusalText(code: string): string | null {
  if (code === "too far") return "Too far away. Walk closer.";
  if (code === "unknown place") return "Nothing to do here.";
  return null;
}

export default function PlayScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const controlsRef = useRef<Controls | null>(null);
  const connectionRef = useRef<WorldConnection | null>(null);
  const gearRef = useRef<Gear>({ blaster: "mk1", skin: "default", sprint: false });
  const questsRef = useRef<QuestView[]>([]);
  const mapRef = useRef<WorldMap | null>(null);
  const promptRef = useRef<Prompt | null>(null);
  /** The game loop reads this every frame, so a panel takes the thumb without a re-render. */
  const sheetRef = useRef(false);
  /** The last ten round trips, for the jitter line in the readout. */
  const pongsRef = useRef<number[]>([]);
  const celebrateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ name: "provider" });
  const [attempt, setAttempt] = useState(0);
  const [host, setHost] = useState("");
  const [copied, setCopied] = useState(false);

  const [shield, setShield] = useState(3);
  const [quests, setQuests] = useState<QuestView[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aimHot, setAimHot] = useState(false);
  const [firedAt, setFiredAt] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [hitAt, setHitAt] = useState(0);
  const [showHint, setShowHint] = useState(false);

  const [sheet, setSheet] = useState<"board" | "shop" | "ladder" | null>(null);
  const [gear, setGear] = useState<Gear>({ blaster: "mk1", skin: "default", sprint: false });
  const [address, setAddress] = useState("");
  const [network, setNetwork] = useState<Network | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [paidAt, setPaidAt] = useState(0);

  const [worldMap, setWorldMap] = useState<WorldMap | null>(null);
  /** The job the player pinned on the board. Null means the game is choosing. */
  const [pinned, setPinned] = useState<string | null>(null);
  /** Starts true so the shop is never the first thing suggested before storage is read. */
  const [seenShop, setSeenShop] = useState(true);
  const [carryUntil, setCarryUntil] = useState<number | null>(null);
  /** Where the player was standing when a panel went up, which is where it stays. */
  const [standingAt, setStandingAt] = useState<{ x: number; z: number } | null>(null);
  /** Which of the three first minute lines is up, or null once they are all behind us. */
  const [lesson, setLesson] = useState<number | null>(null);

  useEffect(() => {
    setHost(window.location.host);
    setShowHint(window.localStorage.getItem(HINT_KEY) === null);
    if (window.localStorage.getItem(FIRST_MINUTE_KEY) === null) setLesson(0);
    setSeenShop(window.localStorage.getItem(SHOP_KEY) !== null);
    setAddress(readSession()?.address ?? "");
  }, []);

  const objective = useMemo(
    () => chooseObjective({ quests, pinned, seenShop }),
    [pinned, quests, seenShop],
  );
  const spots = useMemo(() => (worldMap ? worldSpots(worldMap, quests) : []), [quests, worldMap]);

  // The scene is built inside the boot effect, which may not have run yet when the first
  // quests land, so the latest choice is kept here and pushed again the moment it exists.
  const objectiveRef = useRef<Objective | null>(null);
  const spotsRef = useRef<MarkerSpot[]>([]);
  useEffect(() => {
    objectiveRef.current = objective;
    spotsRef.current = spots;
    worldRef.current?.setMarkers(spots);
    worldRef.current?.setObjective(objective);
  }, [objective, spots]);

  const [wantExplorer, setWantExplorer] = useState(false);

  // Which chain the payouts are on decides which explorer a transaction points at, and it
  // is only worth asking once there is a transaction to point at. The world serves this
  // outside /api, so a refusal is not an error: the hash is then shown as plain text
  // rather than as a link to the wrong chain.
  useEffect(() => {
    if (!wantExplorer || network !== null) return;
    void getHealth().then((result) => {
      if (result.ok) setNetwork(result.data.network);
    });
  }, [network, wantExplorer]);

  const toast = useCallback((text: string) => {
    const entry: Toast = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text };
    setToasts((live) => [...live, entry].slice(-3));
    setTimeout(() => setToasts((live) => live.filter((item) => item.id !== entry.id)), TOAST_MS);
  }, []);

  /**
   * A quest moved. The line the player sees is the next step, and a courier leg also
   * starts the two minute clock here: the wire says the parcel is in hand but not when it
   * was picked up, so the clock runs from the moment this phone was told.
   */
  const announce = useCallback(
    (quest: QuestView) => {
      if (quest.kind === "courier") {
        const carrying = quest.state === "open" && quest.carrying === true;
        setCarryUntil(carrying ? Date.now() + COURIER_WINDOW_MS : null);
      }
      toast(questStep(quest, mapRef.current, worldRef.current?.place() ?? null));
    },
    [toast],
  );

  /** A lesson is over when the player does the thing it taught, or when they tap it away. */
  const lessonDone = useCallback((step: number) => {
    setLesson((current) => {
      if (current === null || current !== step) return current;
      const next = current + 1;
      if (next < LESSONS.length) return next;
      window.localStorage.setItem(FIRST_MINUTE_KEY, "seen");
      return null;
    });
  }, []);

  const retry = useCallback(() => {
    setPhase({ name: "provider" });
    setAttempt((count) => count + 1);
  }, []);

  // Reconnecting and signing back in both keep the city on screen with a line across the
  // top: dropping the player back to a loading screen loses where they were standing.
  const playing =
    phase.name === "playing" || phase.name === "reconnecting" || phase.name === "resigning";

  /**
   * The signature moment. A payout that landed is announced wherever the player is
   * standing: the amount, the block it is in, the shield bars taking the accent, and the
   * row on the board lighting up if the board happens to be open.
   */
  const onPaid = useCallback(
    (claim: ClaimView) => {
      const block = claim.blockNumber === null ? "" : `, block ${claim.blockNumber}`;
      toast(`Bounty paid: ${nim(claim.amountLuna)} NIM${block}`);
      setPaidAt(Date.now());
      setCelebrate(claim.id);
      if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
      celebrateTimer.current = setTimeout(() => setCelebrate(null), 6000);
    },
    [toast],
  );

  const claims = useClaims(playing, onPaid);

  // A paid claim is the one place a link is worth having, so that is the only thing that
  // makes the page ask which chain it is on.
  const hasPayout = claims.claims.some((claim) => claim.state === "paid" && claim.txHash !== null);
  useEffect(() => {
    if (hasPayout) setWantExplorer(true);
  }, [hasPayout]);

  useEffect(() => () => {
    if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
  }, []);

  const openSheet = useCallback((next: "board" | "shop" | "ladder") => {
    sheetRef.current = true;
    setSheet(next);
    setStandingAt(worldRef.current?.place() ?? null);
    if (next === "board") lessonDone(2);
    // A player who has seen the shop once is never sent back to it by the game itself.
    if (next === "shop") {
      window.localStorage.setItem(SHOP_KEY, "seen");
      setSeenShop(true);
    }
  }, [lessonDone]);

  const closeSheet = useCallback(() => {
    sheetRef.current = false;
    setSheet(null);
  }, []);

  // Stable, because the board reloads the day's jobs whenever this changes and the HUD
  // re-renders every couple of seconds on its own.
  const takeQuests = useCallback((next: QuestView[]) => {
    questsRef.current = next;
    setQuests(next);
  }, []);

  useEffect(() => {
    let alive = true;
    let assets: CityAssets | null = null;
    let raf = 0;

    const drop = () => {
      cancelAnimationFrame(raf);
      connectionRef.current?.close();
      connectionRef.current = null;
      controlsRef.current?.dispose();
      controlsRef.current = null;
      worldRef.current?.dispose();
      worldRef.current = null;
      assets?.dispose();
      assets = null;
    };

    const fail = (title: string, body: string) => {
      if (alive) setPhase({ name: "error", title, body });
    };

    const boot = async () => {
      setPhase({ name: "provider" });
      try {
        await waitForProvider(PROVIDER_WAIT_MS);
      } catch {
        if (alive) setPhase({ name: "outside" });
        return;
      }
      if (!alive) return;

      let who = readSession() ? await me() : null;
      if (!alive) return;

      if (!who) {
        setPhase({ name: "signing" });
        try {
          await login();
        } catch (error) {
          if (!alive) return;
          if (isUserRejection(error)) return setPhase({ name: "cancelled" });
          return fail(
            "That sign in did not go through",
            error instanceof Error ? error.message : "The wallet did not answer. Try again.",
          );
        }
        who = await me();
        if (!alive) return;
        if (!who) {
          return fail(
            "That sign in did not go through",
            "The server did not accept the signature. Tap below to sign again.",
          );
        }
      }
      gearRef.current = who.gear;
      setGear(who.gear);
      setAddress(who.address);

      setPhase({ name: "loading", percent: 0 });
      const total = CITY_STEPS + CHARACTER_STEPS + 1;
      let done = 1;
      const step = () => {
        done += 1;
        if (alive) setPhase({ name: "loading", percent: Math.round((done / total) * 100) });
      };

      const mapResult = await getWorldMap();
      if (!alive) return;
      if (!mapResult.ok) {
        return fail("The city did not load", `${mapResult.error} Tap below to try again.`);
      }
      mapRef.current = mapResult.data;
      setWorldMap(mapResult.data);

      try {
        // The city look Ram approved. The facades carry it, so it is chosen at load.
        assets = await loadCityAssets(step, "v2");
        await loadCharacters(step);
      } catch {
        if (!alive) return;
        return fail(
          "The city did not load",
          "Some of the block did not arrive. Check the connection and tap below to try again.",
        );
      }
      if (!alive || !assets) return;

      const canvas = canvasRef.current;
      const surface = surfaceRef.current;
      if (!canvas || !surface) return;

      const session = readSession();
      if (!session) return fail("That sign in did not go through", "Tap below to sign again.");

      const world = createWorld({
        canvas,
        map: mapResult.data,
        assets,
        you: session.address,
        reduced: Boolean(reduced),
        readLook: () => controlsRef.current?.look() ?? { yaw: 0, pitch: 0 },
        // A panel is up: the body stands still rather than walking on under the sheet.
        readMove: () =>
          sheetRef.current ? { dx: 0, dz: 0 } : (controlsRef.current?.move() ?? { dx: 0, dz: 0 }),
        onAim: setAimHot,
        onPrompt: (next) => {
          promptRef.current = next;
          setPrompt(next);
        },
        onShield: setShield,
        onEvent: (event) => {
          if (event.kind === "kill") {
            // The hunt's own frame is a breath behind and carries the count, so the kill
            // only speaks when there is no open hunt to speak for it.
            const hunt = questsRef.current.find((quest) => quest.kind === "hunt");
            if (hunt && hunt.state === "open") return;
            return toast("Drone down");
          }
          if (event.kind === "downed") return toast("Downed. Back at the office in 3");
          if (event.kind === "shieldHit") return setHitAt(Date.now());
        },
      });
      worldRef.current = world;
      world.setMarkers(spotsRef.current);
      world.setObjective(objectiveRef.current);

      const controls = createControls({
        surface,
        onMove: (move) => {
          // A panel is up: the body stands still rather than walking on under the sheet,
          // and the frame loop zeroes its own walk the same way.
          const sent = sheetRef.current ? { ...move, dx: 0, dz: 0 } : move;
          // The world keeps what went out so the server's reply can be replayed against
          // it, and it only keeps what was really sent, not what the thumb asked for.
          worldRef.current?.noteMove(sent);
          connectionRef.current?.send({ t: "move", ...sent });
        },
        onFire: (yaw, pitch) => {
          if (sheetRef.current) return;
          const shot = worldRef.current?.fire(yaw, pitch) ?? { yaw, pitch };
          setFiredAt(Date.now());
          lessonDone(1);
          connectionRef.current?.send({ t: "fire", yaw: shot.yaw, pitch: shot.pitch });
        },
        fireIntervalMs: () => FIRE_INTERVAL[gearRef.current.blaster] ?? FIRE_INTERVAL.mk1,
        onFirstStick: () => {
          window.localStorage.setItem(HINT_KEY, "seen");
          setShowHint(false);
          lessonDone(0);
        },
      });
      controlsRef.current = controls;

      const onResize = () => world.resize();
      window.addEventListener("resize", onResize);
      window.addEventListener("orientationchange", onResize);

      let hidden = false;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        world.frame(now);
      };
      const onVisibility = () => {
        // A signature dialog pauses the WebView. Stopping the loop while the page is out
        // of sight is what keeps the first frame back from stepping a whole second.
        if (document.hidden) {
          hidden = true;
          cancelAnimationFrame(raf);
          return;
        }
        if (!hidden) return;
        hidden = false;
        world.resume(performance.now());
        raf = requestAnimationFrame(tick);
      };
      document.addEventListener("visibilitychange", onVisibility);
      world.resize();
      raf = requestAnimationFrame(tick);

      if (process.env.NODE_ENV !== "production") {
        const debug = window as unknown as { vettaiDebug?: unknown };
        debug.vettaiDebug = {
          stats: () => world.stats(),
          readout: () => world.readout(),
          markers: () => world.markers(),
          place: () => world.place(),
          look: () => controlsRef.current?.look() ?? { yaw: 0, pitch: 0 },
          move: () => controlsRef.current?.move() ?? { dx: 0, dz: 0 },
          cameraAt: () => world.cameraAt(),
          heap: () =>
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? null,
        };
      }

      setPhase({ name: "connecting" });
      const ticket = await getTicket();
      if (!alive) return;
      if (!ticket.ok) {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("orientationchange", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
        return fail("The world server would not let us in", `${ticket.error} Tap below to try again.`);
      }

      let resigning = false;

      /**
       * A ticket refused with 401 clears the token, so an empty session on a dropped
       * socket means the sign in expired rather than the network dying. Retrying that
       * forever gets nowhere: one signature puts the player back in the same city.
       */
      async function signBackIn(): Promise<void> {
        if (resigning) return;
        resigning = true;
        setPhase({ name: "resigning" });
        connectionRef.current?.close();
        connectionRef.current = null;

        try {
          await login();
        } catch (error) {
          resigning = false;
          if (!alive) return;
          if (isUserRejection(error)) return setPhase({ name: "cancelled" });
          return fail(
            "That sign in did not go through",
            error instanceof Error ? error.message : "The wallet did not answer. Try again.",
          );
        }
        if (!alive) return;

        const again = await getTicket();
        resigning = false;
        if (!alive) return;
        if (!again.ok) {
          return fail("The world server would not let us in", `${again.error} Tap below to try again.`);
        }

        const back = connectWorld(again.data.ticket);
        connectionRef.current = back;
        attach(back);
      }

      function attach(connection: WorldConnection): void {
        connection.on("pong", (frame) => {
          const round = Date.now() - frame.ts;
          const seen = pongsRef.current;
          seen.push(round);
          if (seen.length > 10) seen.shift();
        });

        connection.on("welcome", (frame) => {
          world.welcome(frame);
          questsRef.current = frame.quests;
          setQuests(frame.quests);
          setPhase({ name: "playing" });
        });

        let spoke = 0;
        connection.on("state", (frame) => {
          world.state(frame);
          if (process.env.NODE_ENV === "production") return;
          // One line a second while developing: enough to see the room ticking, not enough
          // to drown the console at twenty frames a second.
          const now = Date.now();
          if (now - spoke < 1000) return;
          spoke = now;
          const at = world.place();
          console.info(
            `[vettai] state tick=${frame.tick} players=${frame.players.length} drones=${frame.drones.length} at=${at.x.toFixed(1)},${at.z.toFixed(1)}`,
          );
        });

        connection.on("event", (frame) => {
          if (frame.kind === "quest") {
            const next = [
              ...questsRef.current.filter((quest) => quest.id !== frame.quest.id),
              frame.quest,
            ].sort((a, b) => a.kind.localeCompare(b.kind));
            questsRef.current = next;
            setQuests(next);

            announce(frame.quest);
            return;
          }
          if (frame.kind === "gear") {
            gearRef.current = frame.gear;
            setGear(frame.gear);
            world.setGear(frame.gear);
            toast(`Gear equipped: ${frame.item}`);
            return;
          }
          if (frame.kind === "interact") {
            // The server has just confirmed the player really is standing at the door, so
            // the panel opens on its word rather than on the phone's guess.
            if (frame.target === "office") openSheet("board");
            if (frame.target === "shop") openSheet("shop");
            return;
          }
          if (frame.kind === "leave") {
            world.leave(frame.player);
            return;
          }
          if (frame.kind === "error") {
            const line = refusalText(frame.code);
            if (line) toast(line);
          }
        });

        connection.on("close", (frame) => {
          if (!alive || !frame.willRetry) return;
          if (readSession() === null) return void signBackIn();
          setPhase({ name: "reconnecting" });
        });
      }

      const connection = connectWorld(ticket.data.ticket);
      connectionRef.current = connection;
      attach(connection);

      const pinged = setInterval(() => setLatency(connectionRef.current?.latency() ?? null), 2000);

      return () => {
        clearInterval(pinged);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("orientationchange", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    };

    let later: (() => void) | undefined;
    void boot().then((cleanup) => {
      later = cleanup ?? undefined;
      if (!alive) later?.();
    });

    return () => {
      alive = false;
      later?.();
      drop();
    };
  }, [announce, attempt, lessonDone, openSheet, reduced, toast]);

  const interact = useCallback(() => {
    const target = promptRef.current;
    const connection = connectionRef.current;
    if (!target || !connection) return;

    if (target.kind === "office") return connection.send({ t: "interact", target: "office" });
    if (target.kind === "shop") return connection.send({ t: "interact", target: "shop" });
    if (target.kind === "landmark") {
      return connection.send({ t: "interact", target: `landmark:${target.index}` });
    }

    const courier = questsRef.current.find((quest) => quest.kind === "courier");
    if (!courier || courier.state !== "open" || !courier.route) return;
    const carrying = courier.carrying === true;
    if (!carrying && courier.route.from === target.point) {
      return connection.send({ t: "interact", target: "pickup" });
    }
    if (carrying && courier.route.to === target.point) {
      return connection.send({ t: "interact", target: "deliver" });
    }
  }, []);

  const attachFire = useCallback((button: HTMLElement | null) => {
    if (!button) return;
    controlsRef.current?.attachFire(button);
  }, []);

  /** What the readout panel reads while it is open. Nothing here runs on a frame. */
  const readout = useCallback((): Panel | null => {
    const world = worldRef.current;
    if (!world) return null;
    const seen = pongsRef.current;
    const jitter = seen.length < 2 ? null : Math.max(...seen) - Math.min(...seen);
    return { ...world.readout(), latency: connectionRef.current?.latency() ?? null, jitter };
  }, []);

  const deepLink = host ? `https://nimpay.app/miniapps/open/${host}/play` : "";

  const copyLink = useCallback(() => {
    if (!deepLink) return;
    void navigator.clipboard?.writeText(deepLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [deepLink]);

  return (
    <div className={`${styles.stage} overflow-hidden bg-night`}>
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />

      {playing && <div aria-hidden className={styles.vignette} />}

      <div
        ref={surfaceRef}
        className={`absolute inset-0 select-none ${sheet ? "pointer-events-none" : "touch-none"}`}
        style={{ touchAction: "none" }}
      />

      {playing && (
        <Hud
          shield={shield}
          quests={quests}
          objective={objective}
          carryUntil={carryUntil}
          toasts={toasts}
          latency={latency}
          aimHot={aimHot}
          firedAt={firedAt}
          prompt={promptAction(prompt, quests, objective)}
          onInteract={interact}
          onOpenBoard={() => openSheet("board")}
          nearOffice={prompt?.kind === "office"}
          payouts={claims.inFlight}
          paidAt={paidAt}
          attachFire={attachFire}
          hitAt={hitAt}
          showHint={showHint && lesson === null}
          sheetOpen={sheet !== null}
          reduced={Boolean(reduced)}
          readout={readout}
        />
      )}

      <AnimatePresence>
        {playing && lesson !== null && sheet === null && (
          <FirstMinute lesson={lesson} reduced={Boolean(reduced)} onTap={() => lessonDone(lesson)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sheet === "board" && (
          <QuestBoard
            key="board"
            quests={quests}
            claims={claims}
            network={network}
            reduced={Boolean(reduced)}
            celebrate={celebrate}
            map={worldMap}
            place={standingAt}
            tracked={pinned}
            onTrack={setPinned}
            onQuests={takeQuests}
            onLadder={() => openSheet("ladder")}
            onClose={closeSheet}
          />
        )}
        {sheet === "shop" && (
          <Shop
            key="shop"
            gear={gear}
            network={network}
            reduced={Boolean(reduced)}
            onClose={closeSheet}
          />
        )}
        {sheet === "ladder" && (
          <Ladder
            key="ladder"
            address={address}
            reduced={Boolean(reduced)}
            onClose={closeSheet}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(phase.name === "reconnecting" || phase.name === "resigning") && (
          <motion.div
            key={phase.name}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center pt-3"
          >
            <span
              data-testid="link-banner"
              className="label-type rounded-btn border border-hunt/40 bg-night/80 px-3 py-2 text-hunt backdrop-blur"
            >
              {phase.name === "resigning"
                ? "Signing you back in"
                : "Connection dropped. Getting you back in"}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* One panel at a time: two headlines dissolving through each other reads as a fault. */}
      <AnimatePresence mode="wait">
        {!playing && (
          <motion.div
            key={phase.name}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.5, ease: EASE }}
            className="absolute inset-0 z-40 flex flex-col justify-end"
          >
            {/* SWAP: poster still. Until the city is built the screen is lit by hand: one
                cold light source high on the left, one hunt coloured glow on the horizon. */}
            {phase.name !== "connecting" && (
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background:
                    "radial-gradient(120% 75% at 14% 14%, #1a2440 0%, #0f1526 40%, #0b0f1a 78%)",
                }}
              />
            )}
            <div
              aria-hidden
              className="pointer-events-none absolute -right-40 top-[16%] h-[520px] w-[520px] rounded-full border border-hunt/12"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
              style={{
                background: "linear-gradient(to top, rgba(255,106,43,0.14) 0%, transparent 72%)",
              }}
            />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(to top, #0b0f1a 8%, rgba(11,15,26,0.92) 42%, rgba(11,15,26,0.45) 100%)",
              }}
            />
            <div className="label-type absolute inset-x-0 top-0 flex items-center justify-between gap-3 border-b border-line px-6 pb-3 pt-[max(1.25rem,env(safe-area-inset-top))] text-paper/35">
              <span>Vettai</span>
              <span>The hunt</span>
              <span className="text-hunt/70">Nimiq Pay</span>
            </div>
            <Panel
              phase={phase}
              reduced={Boolean(reduced)}
              deepLink={deepLink}
              copied={copied}
              onCopy={copyLink}
              onRetry={retry}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The button the thumb reaches for when the player is standing on something. It says the
 * action, not the place, and it wears the accent when the place is the tracked objective.
 */
function promptAction(
  prompt: Prompt | null,
  quests: QuestView[],
  objective: Objective | null,
): { text: string; primary: boolean } | null {
  if (!prompt) return null;
  const tracked = (id: string) => objective?.spots.includes(id) === true;

  if (prompt.kind === "office") return { text: "Open the board", primary: tracked("office") };
  if (prompt.kind === "shop") return { text: "Open the shop", primary: tracked("shop") };
  if (prompt.kind === "landmark") {
    return { text: "Visit landmark", primary: tracked(`landmark:${prompt.index}`) };
  }

  const courier = quests.find((quest) => quest.kind === "courier");
  if (!courier || courier.state !== "open" || !courier.route) return null;
  const carrying = courier.carrying === true;
  const primary = tracked("courier");
  if (!carrying && courier.route.from === prompt.point) return { text: "Pick up", primary };
  if (carrying && courier.route.to === prompt.point) return { text: "Deliver", primary };
  return null;
}

/**
 * The first minute, and only ever the first. Three lines, each one dismissed by doing the
 * thing it asks for or by tapping it. Everything but the words is left clickable, so the
 * lesson can be finished with the thumb it is teaching.
 */
const LESSONS = [
  {
    step: "Walk",
    title: "Drag left to walk, drag right to look",
    note: "Two thumbs, no buttons to learn.",
  },
  {
    step: "Shoot",
    title: "Tap FIRE when the ring is on a drone",
    note: "The ring picks the drone out for you.",
  },
  {
    step: "Get paid",
    title: "Bounties are paid to your wallet at the office",
    note: "Follow the orange beam, claim at the board.",
  },
];

function FirstMinute({
  lesson,
  reduced,
  onTap,
}: {
  lesson: number;
  reduced: boolean;
  onTap: () => void;
}) {
  const words = LESSONS[lesson];
  if (!words) return null;

  const glow = ["18% 82%", "84% 86%", "16% 16%"][lesson] ?? "50% 50%";

  return (
    <motion.div
      key="first-minute"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.5, ease: EASE }}
      data-testid="first-minute"
      className="pointer-events-none absolute inset-0 z-30"
    >
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `radial-gradient(70% 45% at ${glow}, rgba(255,106,43,0.18) 0%, rgba(11,15,26,0.82) 45%, rgba(11,15,26,0.88) 100%)`,
        }}
      />

      {lesson === 0 && <Ghost className="bottom-[20%] left-[16%] h-28 w-28" reduced={reduced} />}
      {lesson === 1 && (
        <Ghost
          className="bottom-[max(2.5rem,calc(env(safe-area-inset-bottom)+1.5rem))] right-6 h-[72px] w-[72px]"
          reduced={reduced}
        />
      )}
      {lesson === 2 && (
        <Ghost
          className="left-3 top-[max(2.8rem,calc(env(safe-area-inset-top)+2.3rem))] h-24 w-56 rounded-btn"
          reduced={reduced}
        />
      )}

      <AnimatePresence mode="wait">
        <motion.button
          key={lesson}
          type="button"
          onClick={onTap}
          initial={{ opacity: 0, y: reduced ? 0 : 22 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -16 }}
          transition={{ duration: reduced ? 0 : 0.5, ease: EASE }}
          data-testid="first-minute-tap"
          className="pointer-events-auto absolute left-6 right-6 top-[38%] text-left"
        >
          <span className="label-type text-hunt">
            {lesson + 1} / {LESSONS.length} &#183; {words.step}
          </span>
          <span className="display-type mt-3 block max-w-[14ch] text-[clamp(2rem,9vw,3.4rem)] uppercase leading-[0.92] tracking-[-0.02em] text-paper">
            {words.title}
          </span>
          <span className="mt-3 block max-w-[32ch] text-base text-paper/60">{words.note}</span>
          <span className="label-type mt-5 block text-paper/35">Tap to carry on</span>
        </motion.button>
      </AnimatePresence>
    </motion.div>
  );
}

/** The outline that says where to put the thumb. It breathes unless the phone says not to. */
function Ghost({ className, reduced }: { className: string; reduced: boolean }) {
  return (
    <motion.span
      aria-hidden
      animate={reduced ? { opacity: 0.5 } : { opacity: [0.25, 0.75, 0.25], scale: [1, 1.06, 1] }}
      transition={reduced ? { duration: 0 } : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      className={`absolute rounded-full border-2 border-hunt ${className}`}
    />
  );
}

type PanelProps = {
  phase: Phase;
  reduced: boolean;
  deepLink: string;
  copied: boolean;
  onCopy: () => void;
  onRetry: () => void;
};

const COPY: Record<string, { label: string; title: string; body: string }> = {
  provider: {
    label: "Nimiq Pay",
    title: "Looking for Nimiq Pay",
    body: "Vettai is asking the wallet for your address. It answers a second or two after the app opens.",
  },
  outside: {
    label: "Nimiq Pay",
    title: "Open Vettai inside Nimiq Pay",
    body: "The bounty is paid in NIM to your wallet, so the game runs inside Nimiq Pay. Open this link on the phone that has the app.",
  },
  signing: {
    label: "One signature",
    title: "Signing you in",
    body: "Nimiq Pay asks you to sign a short message so the server knows whose wallet is playing. Nothing is sent and nothing is spent.",
  },
  cancelled: {
    label: "Cancelled",
    title: "Sign in cancelled. Nothing was sent.",
    body: "The world needs to know whose wallet is playing before it can hand you a body in the city. Sign once and you are in.",
  },
  loading: {
    label: "The block",
    title: "Loading the block",
    body: "Streets, towers, drones and people, straight from the world server.",
  },
  connecting: {
    label: "The city",
    title: "Taking a seat in the city",
    body: "Asking the world server for a room. Other players are already out there.",
  },
};

function Panel({ phase, reduced, deepLink, copied, onCopy, onRetry }: PanelProps) {
  const words =
    phase.name === "error"
      ? { label: "Stopped", title: phase.title, body: phase.body }
      : COPY[phase.name];
  if (!words) return null;

  const rise = {
    initial: { opacity: 0, y: 26 },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { duration: 0.7, ease: EASE },
  };

  return (
    <div className="relative z-10 px-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
      <motion.p {...rise} className="label-type text-hunt">
        {words.label}
      </motion.p>

      <motion.h1
        {...rise}
        transition={{ ...rise.transition, delay: reduced ? 0 : 0.06 }}
        className="display-type mt-3 max-w-[16ch] text-[clamp(2.4rem,11vw,4.5rem)] leading-[0.92] tracking-[-0.02em] uppercase"
      >
        {words.title}
      </motion.h1>

      <motion.p
        {...rise}
        transition={{ ...rise.transition, delay: reduced ? 0 : 0.12 }}
        className="mt-4 max-w-[38ch] text-base text-paper/65"
      >
        {words.body}
      </motion.p>

      <motion.div
        {...rise}
        transition={{ ...rise.transition, delay: reduced ? 0 : 0.18 }}
        className="mt-7"
      >
        {phase.name === "loading" && <Progress percent={phase.percent} />}

        {(phase.name === "provider" || phase.name === "signing" || phase.name === "connecting") && (
          <Waiting
            label={
              phase.name === "signing" ? "Confirm in Nimiq Pay" : "This takes a moment, not a minute"
            }
          />
        )}

        {phase.name === "outside" && (
          <div className="flex flex-col gap-3">
            <a
              href={deepLink}
              className="rounded-btn bg-hunt px-5 py-3 text-center font-medium text-night transition-transform duration-300 hover:scale-[1.02] active:scale-[0.99]"
            >
              Open in Nimiq Pay
            </a>
            <button
              type="button"
              onClick={onCopy}
              className="label-type rounded-btn border border-line px-5 py-3 text-paper/60 transition-colors duration-300 hover:border-hunt hover:text-paper"
            >
              {copied ? "Link copied" : "Copy the link"}
            </button>
          </div>
        )}

        {(phase.name === "cancelled" || phase.name === "error") && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-btn bg-hunt px-5 py-3 font-medium text-night transition-transform duration-300 hover:scale-[1.02] active:scale-[0.99]"
          >
            Try again
          </button>
        )}
      </motion.div>
    </div>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="live-dot h-2 w-2 rounded-full bg-hunt" />
      <span className="label-type text-paper/45">{label}</span>
    </div>
  );
}

function Progress({ percent }: { percent: number }) {
  return (
    <div className="max-w-sm">
      <div className="h-[3px] w-full overflow-hidden bg-paper/12">
        <motion.div
          className="h-full bg-hunt"
          animate={{ width: `${percent}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </div>
      <p className="label-type mt-3 text-paper/45">{percent}% loaded</p>
    </div>
  );
}
