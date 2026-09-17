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
import { isInsidePay, isUserRejection, waitForProvider } from "@/lib/nimiq";
import { login, me, readSession } from "@/lib/session";
import { connectWorld, youOf, type WelcomeFrame, type WorldConnection } from "@/lib/ws";
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
import Hud, { type Panel, type PromptAction, type Toast } from "./Hud";
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
  /** The phone took the graphics away. The city is being built again on a fresh canvas. */
  | { name: "lost" }
  | { name: "error"; title: string; body: string };

const PROVIDER_WAIT_MS = 15_000;

/**
 * How long a socket gets to hand over a room. The world sends the welcome on the tick
 * after the upgrade, so anything past this is a connection that upgraded and then went
 * quiet, which no amount of waiting fixes.
 */
const WELCOME_WAIT_MS = 8000;

/** How often the page looks again for a wallet that turned up after we gave up waiting. */
const PROVIDER_POLL_MS = 500;
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
  /** The HUD's fire button, so a rebuilt set of controls can take it over. */
  const fireButtonRef = useRef<HTMLElement | null>(null);
  /** The room as the server last described it, which is what a rebuilt picture starts from. */
  const lastWelcome = useRef<WelcomeFrame | null>(null);
  /** What the room calls this player, taken from the welcome rather than guessed. */
  const youId = useRef("");
  /** Where the body was standing when the graphics went away. */
  const placeRef = useRef<{ x: number; z: number } | null>(null);
  /** The block this game loaded, as the map endpoint stamped it. */
  const mapVersion = useRef("");
  /** The version we have already gone back for, so a disagreeing world cannot loop us. */
  const rebootedFor = useRef("");
  /** Turns the render loop on and off from the React side, which knows what phase we are in. */
  const setLoop = useRef<(on: boolean) => void>(() => {});
  /** The one signature that puts an expired session back, owned by the boot below. */
  const signBackInRef = useRef<(() => Promise<void>) | null>(null);
  const contextLost = useRef<() => void>(() => {});
  const contextBack = useRef<() => void>(() => {});
  const rebuild = useRef<() => void>(() => {});

  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ name: "provider" });
  const [attempt, setAttempt] = useState(0);
  /** Bumped to mount a brand new canvas, which is the only clean way back from a lost context. */
  const [picture, setPicture] = useState(0);
  const [host, setHost] = useState("");
  const [copied, setCopied] = useState(false);
  /** True when this page is running inside Nimiq Pay, which changes what a missing wallet means. */
  const [insidePay, setInsidePay] = useState(false);

  const [shield, setShield] = useState(3);
  const [quests, setQuests] = useState<QuestView[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aimHot, setAimHot] = useState(false);
  const [firedAt, setFiredAt] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  /** Where the player stood when that prompt appeared, which is what its distances mean. */
  const [promptAt, setPromptAt] = useState<{ x: number; z: number } | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [hitAt, setHitAt] = useState(0);

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
    if (window.localStorage.getItem(FIRST_MINUTE_KEY) === null) setLesson(0);
    setSeenShop(window.localStorage.getItem(SHOP_KEY) !== null);
    setInsidePay(isInsidePay());
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
  /** What one wallet may be paid today, as the world server states it, or null if it will not. */
  const [dailyCapNim, setDailyCapNim] = useState<string | null>(null);
  const askedHealth = useRef(false);

  // Two things come off the same call: which chain a payout links to, and what the day's
  // cap is for the line on the board. It is asked once, the first time either is wanted.
  // The world serves this outside /api, so a refusal is not an error: the board then says
  // nothing about the cap and a hash is shown as text rather than as the wrong link.
  useEffect(() => {
    if (!wantExplorer && sheet !== "board") return;
    if (askedHealth.current) return;
    askedHealth.current = true;
    void getHealth().then((result) => {
      if (!result.ok) return;
      setNetwork(result.data.network);
      setDailyCapNim(result.data.dailyCapNim ?? null);
    });
  }, [sheet, wantExplorer]);

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

  // The claims feed hits the same session the socket does, so when it finds the sign in
  // gone it goes down the same road rather than quietly stopping.
  const signedOut = useCallback(() => {
    void signBackInRef.current?.();
  }, []);

  const claims = useClaims(playing, onPaid, signedOut);

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
    let running = false;
    let onScreen = true;
    let wantLoop = false;
    let frames = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      frames += 1;
      worldRef.current?.frame(now);
    };

    /**
     * One switch for the render loop. A hidden page, a picture that is being rebuilt and a
     * world that is not there yet all stop it, and it only starts again when none of them
     * do. A signature dialog pauses the WebView, and stopping here is what keeps the first
     * frame back from stepping a whole second.
     */
    const syncLoop = () => {
      const should = wantLoop && onScreen && worldRef.current !== null;
      if (should === running) return;
      running = should;
      if (!should) return cancelAnimationFrame(raf);
      worldRef.current?.resume(performance.now());
      raf = requestAnimationFrame(tick);
    };

    const onResize = () => worldRef.current?.resize();
    const onVisibility = () => {
      onScreen = !document.hidden;
      syncLoop();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    const dropPicture = () => {
      wantLoop = false;
      syncLoop();
      controlsRef.current?.dispose();
      controlsRef.current = null;
      worldRef.current?.dispose();
      worldRef.current = null;
      assets?.dispose();
      assets = null;
    };

    const drop = () => {
      connectionRef.current?.close();
      connectionRef.current = null;
      dropPicture();
    };

    const fail = (title: string, body: string) => {
      if (alive) setPhase({ name: "error", title, body });
    };

    /**
     * The picture: the block's textures, the scene that draws them and the thumbs that
     * drive it. Built at boot, and built again from nothing when the phone takes the
     * graphics away. It throws when the block will not load, and the caller says so.
     */
    const buildPicture = async (step: () => void): Promise<boolean> => {
      const canvas = canvasRef.current;
      const surface = surfaceRef.current;
      const map = mapRef.current;
      const session = readSession();
      if (!canvas || !surface || !map || !session) return false;

      // The city look Ram approved. The facades carry it, so it is chosen at load.
      assets = await loadCityAssets(step, "v2");
      await loadCharacters(step);
      if (!alive || !assets) return false;

      const world = createWorld({
        canvas,
        map,
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
          setPromptAt(world.place());
        },
        onShield: setShield,
        onEvent: (event) => {
          if (event.kind === "kill") {
            // With sparks off there is nothing in the scene holding the moment for the
            // half second the hunt's count takes to come back, so the word goes out now
            // and the count follows it.
            if (reduced) return toast("Drone down");
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
        onFirstStick: () => lessonDone(0),
      });
      controlsRef.current = controls;
      // The HUD is already on screen when the picture is rebuilt, so the fire button hands
      // itself to the new controls here rather than on a mount that is not happening.
      if (fireButtonRef.current) controls.attachFire(fireButtonRef.current);

      world.resize();
      // Whether the loop actually runs is the phase's call, not this one's: there is
      // nothing worth drawing until the world server has handed over a room.
      syncLoop();
      return true;
    };

    setLoop.current = (on: boolean) => {
      wantLoop = on;
      syncLoop();
    };

    contextLost.current = () => {
      wantLoop = false;
      syncLoop();
      if (alive) setPhase({ name: "lost" });
    };

    contextBack.current = () => {
      if (!alive) return;
      // The canvas that lost its context goes in the bin with the world that drew on it.
      // A fresh one is mounted in its place, and the rebuild runs against that one.
      placeRef.current = worldRef.current?.place() ?? null;
      dropPicture();
      setPicture((count) => count + 1);
    };

    rebuild.current = () => {
      void (async () => {
        let built = false;
        try {
          built = await buildPicture(() => {});
        } catch {
          if (!alive) return;
          return fail(
            "The picture did not come back",
            "The block did not load again. Tap below to start over.",
          );
        }
        if (!alive || !built) return;

        // The room is still ours, so the last welcome puts the city back as it was, with
        // the body where it was standing rather than back at the spawn.
        const back = lastWelcome.current;
        if (back) {
          const at = placeRef.current;
          worldRef.current?.welcome(
            at === null
              ? back
              : {
                  ...back,
                  players: back.players.map((wire) =>
                    wire.id === youId.current ? { ...wire, x: at.x, z: at.z } : wire,
                  ),
                },
          );
        }
        setPhase(back ? { name: "playing" } : { name: "connecting" });
      })();
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
      mapVersion.current = mapResult.data.version;
      setWorldMap(mapResult.data);

      let built = false;
      try {
        built = await buildPicture(step);
      } catch {
        if (!alive) return;
        return fail(
          "The city did not load",
          "Some of the block did not arrive. Check the connection and tap below to try again.",
        );
      }
      if (!alive || !built) return;

      /**
       * A room says hello. This is also where a block that has changed under us is caught:
       * the city on screen was built from the map endpoint, so a room running a different
       * one has to be met with a fresh load rather than a player walking through walls
       * that are no longer there.
       */
      const onWelcome = (frame: WelcomeFrame) => {
        if (!alive) return;
        const version = frame.mapVersion;
        if (version && version !== mapVersion.current && rebootedFor.current !== version) {
          rebootedFor.current = version;
          setAttempt((count) => count + 1);
          return;
        }

        lastWelcome.current = frame;
        youId.current = youOf(frame);
        worldRef.current?.welcome(frame);
        // A room counts move intents from zero. The thumb has to count from the same
        // place, or the first frames back replay every intent the old room never
        // acknowledged. The world clears what it was holding in welcome().
        const mine = frame.players.find((wire) => wire.id === youId.current);
        controlsRef.current?.resetSequence(mine?.seq ?? 0);
        questsRef.current = frame.quests;
        setQuests(frame.quests);
        setPhase({ name: "playing" });
      };

      if (process.env.NODE_ENV !== "production") {
        const debug = window as unknown as { vettaiDebug?: unknown };
        debug.vettaiDebug = {
          stats: () => worldRef.current?.stats() ?? null,
          readout: () => worldRef.current?.readout() ?? null,
          markers: () => worldRef.current?.markers() ?? null,
          killFlashAt: () => worldRef.current?.killFlashAt() ?? 0,
          place: () => worldRef.current?.place() ?? null,
          look: () => controlsRef.current?.look() ?? { yaw: 0, pitch: 0 },
          move: () => controlsRef.current?.move() ?? { dx: 0, dz: 0 },
          cameraAt: () => worldRef.current?.cameraAt() ?? null,
          /** What the render loop is doing, so a check can prove it stopped and started. */
          loop: () => ({ running, frames }),
          /** The block this game loaded, and the way a check can hand the page a welcome. */
          mapVersion: () => mapVersion.current,
          welcome: (frame: WelcomeFrame) => onWelcome(frame),
          heap: () =>
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? null,
        };
      }

      setPhase({ name: "connecting" });
      const ticket = await getTicket();
      if (!alive) return;
      if (!ticket.ok) {
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

      signBackInRef.current = signBackIn;

      function attach(connection: WorldConnection): void {
        connection.on("pong", (frame) => {
          const round = Date.now() - frame.ts;
          const seen = pongsRef.current;
          seen.push(round);
          if (seen.length > 10) seen.shift();
        });

        connection.on("welcome", onWelcome);

        let spoke = 0;
        connection.on("state", (frame) => {
          worldRef.current?.state(frame);
          if (process.env.NODE_ENV === "production") return;
          // One line a second while developing: enough to see the room ticking, not enough
          // to drown the console at twenty frames a second.
          const now = Date.now();
          if (now - spoke < 1000) return;
          spoke = now;
          const at = worldRef.current?.place() ?? { x: 0, z: 0 };
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
            worldRef.current?.setGear(frame.gear);
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
            worldRef.current?.leave(frame.player);
            return;
          }
          if (frame.kind === "error") {
            const line = refusalText(frame.code);
            if (line) toast(line);
          }
        });

        connection.on("close", (frame) => {
          if (!alive) return;
          if (frame.fatal) {
            // The socket has given up for a reason retrying cannot fix, so the player is
            // told rather than left watching a banner that will never clear.
            return fail(
              "The city closed the connection",
              `${frame.reason}. Tap below to try again.`,
            );
          }
          if (!frame.willRetry) return;
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
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      drop();
    };
  }, [announce, attempt, lessonDone, openSheet, reduced, toast]);

  // Nothing is drawn while a panel owns the screen. A phone that is waiting to connect or
  // has lost its picture should not be spending its battery on frames nobody sees.
  useEffect(() => {
    setLoop.current(playing);
  }, [playing]);

  /**
   * Pay can be slow to hand a cold start its wallet, and on a phone that has been asleep it
   * can be very slow. Rather than leaving the player on a dead end, the page keeps looking
   * and boots itself the moment the wallet shows up.
   */
  useEffect(() => {
    if (phase.name !== "outside") return;
    const timer = setInterval(() => {
      if (typeof window !== "undefined" && window.nimiq) return retry();
      setInsidePay(isInsidePay());
    }, PROVIDER_POLL_MS);
    return () => clearInterval(timer);
  }, [phase.name, retry]);

  /**
   * The socket can upgrade and then say nothing, which used to sit on the connecting panel
   * for ever. This gives a room eight seconds to arrive and then says so out loud. The
   * socket keeps trying underneath, so a welcome that turns up late still drops the player
   * straight into the city.
   */
  useEffect(() => {
    if (phase.name !== "connecting" && phase.name !== "reconnecting") return;
    const timer = setTimeout(() => {
      setPhase({
        name: "error",
        title: "The city did not answer",
        body: "The world server took the connection but never handed over a room. Tap below to try again.",
      });
    }, WELCOME_WAIT_MS);
    return () => clearTimeout(timer);
  }, [phase.name]);

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
    fireButtonRef.current = button;
    if (!button) return;
    controlsRef.current?.attachFire(button);
  }, []);

  /**
   * The canvas listens for its own context going away. Calling preventDefault is what asks
   * the browser to hand one back; without it the restore event never comes.
   */
  const attachCanvas = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    if (!node) return;
    const lost = (event: Event) => {
      event.preventDefault();
      contextLost.current();
    };
    const back = () => contextBack.current();
    node.addEventListener("webglcontextlost", lost);
    node.addEventListener("webglcontextrestored", back);
    return () => {
      node.removeEventListener("webglcontextlost", lost);
      node.removeEventListener("webglcontextrestored", back);
    };
  }, []);

  // A fresh canvas has just been mounted in place of the one that lost its context, so the
  // city is built again on it. The first canvas is built by the boot above.
  useEffect(() => {
    if (picture === 0) return;
    rebuild.current();
  }, [picture]);

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
      {/* A fresh canvas for every world. Tearing one down hands its context back to the
          phone, so a rebuilt city cannot draw on the canvas the last one used. */}
      <canvas
        key={`${attempt}-${picture}`}
        ref={attachCanvas}
        className="absolute inset-0 block h-full w-full"
      />

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
          prompt={promptAction(prompt, quests, objective, worldMap, promptAt)}
          onInteract={interact}
          onOpenBoard={() => openSheet("board")}
          payouts={claims.inFlight}
          held={claims.held}
          heldOnPool={claims.heldOnPool}
          paidAt={paidAt}
          attachFire={attachFire}
          hitAt={hitAt}
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
            dailyCapNim={dailyCapNim}
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
            {/* The screen before the city: one cold light high on the left, the street's own
                orange on the horizon, and the block's rooflines standing in the haze. */}
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
            <Skyline reduced={Boolean(reduced)} />
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
                  "linear-gradient(to top, #0b0f1a 15%, rgba(11,15,26,0.88) 33%, rgba(11,15,26,0.18) 62%, rgba(11,15,26,0) 100%)",
              }}
            />
            <div className="label-type absolute inset-x-0 top-0 flex items-center justify-between gap-3 border-b border-line px-6 pb-3 pt-[max(1.25rem,env(safe-area-inset-top))] text-paper/35">
              <span>Vettai</span>
              <span>The hunt</span>
              <span className="text-hunt/70">Nimiq Pay</span>
            </div>

            {/* The first paint comes off the server, so what it starts at may not depend on
                a media query this phone has and that render did not. Only the travel does. */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0 } : { duration: 0.7, ease: EASE, delay: 0.1 }}
              data-testid="loading-mark"
              className="absolute left-6 top-[max(4.5rem,calc(env(safe-area-inset-top)+3.6rem))] flex items-center gap-3"
            >
              <motion.span
                aria-hidden
                animate={reduced ? { rotate: 45 } : { rotate: [45, 135, 45] }}
                transition={
                  reduced ? { duration: 0 } : { duration: 7, repeat: Infinity, ease: "easeInOut" }
                }
                className="block h-4 w-4 shrink-0 bg-hunt"
              />
              <span
                className="display-type uppercase leading-none text-paper"
                style={{ fontSize: "clamp(2.2rem,11vw,3.4rem)", letterSpacing: "-0.03em" }}
              >
                Vettai
              </span>
            </motion.div>
            <Panel
              phase={phase}
              reduced={Boolean(reduced)}
              deepLink={deepLink}
              copied={copied}
              insidePay={insidePay}
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
  map: WorldMap | null,
  at: { x: number; z: number } | null,
): PromptAction | null {
  if (!prompt) return null;
  const tracked = (id: string) => objective?.spots.includes(id) === true;
  const act = (text: string, primary: boolean): PromptAction => ({ kind: "do", text, primary });

  if (prompt.kind === "office") return act("Open the board", tracked("office"));
  if (prompt.kind === "shop") return act("Open the shop", tracked("shop"));
  if (prompt.kind === "landmark") {
    return act("Visit landmark", tracked(`landmark:${prompt.index}`));
  }

  const courier = quests.find((quest) => quest.kind === "courier");
  if (!courier || courier.state !== "open" || !courier.route) return null;
  const carrying = courier.carrying === true;
  const primary = tracked("courier");
  if (!carrying && courier.route.from === prompt.point) return act("Pick up", primary);
  if (carrying && courier.route.to === prompt.point) return act("Deliver", primary);

  // One of the other six points. The server would throw an interact here away without a
  // word, so the phone answers instead: this is not the one, and here is the one that is.
  const wanted = carrying ? courier.route.to : courier.route.from;
  const spot = map?.courier[wanted] ?? null;
  const away = spot && at ? `, ${metres(groundRange(at, spot))}` : "";
  return {
    kind: "note",
    text: `Not this one. ${carrying ? "Deliver" : "Pick up"} at P${wanted + 1}${away}`,
  };
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
  insidePay: boolean;
  onCopy: () => void;
  onRetry: () => void;
};

/** Inside Pay a missing wallet is the app still waking up, not the wrong browser. */
const STARTING_UP = {
  label: "Nimiq Pay",
  title: "Nimiq Pay is still starting up",
  body: "The app has not handed this page a wallet yet. It takes a second or two after a cold start. This screen boots the city the moment it arrives.",
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
  lost: {
    label: "The picture",
    title: "Restarting the picture",
    body: "The phone took the graphics back for a moment. The block is being drawn again. Your place in the city is held.",
  },
  connecting: {
    label: "The city",
    title: "Taking a seat in the city",
    body: "Asking the world server for a room. Other players are already out there.",
  },
};

function Panel({ phase, reduced, deepLink, copied, insidePay, onCopy, onRetry }: PanelProps) {
  const words =
    phase.name === "error"
      ? { label: "Stopped", title: phase.title, body: phase.body }
      : phase.name === "outside" && insidePay
        ? STARTING_UP
        : COPY[phase.name];
  if (!words) return null;

  const status = statusOf(phase);

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

        {status && <Status text={status} />}

        {phase.name === "outside" && !insidePay && (
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

        {(phase.name === "cancelled" || phase.name === "error" || phase.name === "outside") && (
          <button
            type="button"
            onClick={onRetry}
            data-testid="try-again"
            className={`rounded-btn px-5 py-3 font-medium transition-transform duration-300 hover:scale-[1.02] active:scale-[0.99] ${
              phase.name === "outside" && !insidePay
                ? "mt-3 border border-line text-paper/60"
                : "bg-hunt text-night"
            }`}
          >
            Try again
          </button>
        )}
      </motion.div>
    </div>
  );
}

/** One honest line for the wait that is actually happening. */
function Status({ text }: { text: string }) {
  return (
    <div className="mt-4 flex items-center gap-3" data-testid="loading-status">
      <span className="live-dot h-2 w-2 rounded-full bg-hunt" />
      <span className="label-type text-paper/45">{text}</span>
    </div>
  );
}

function statusOf(phase: Phase): string | null {
  if (phase.name === "provider") return "looking for the wallet";
  if (phase.name === "signing") return "waiting for your signature";
  if (phase.name === "loading") return "loading the block";
  if (phase.name === "connecting") return "joining the street";
  if (phase.name === "lost") return "drawing the block again";
  return null;
}

/**
 * The block, as a rooftop line. Towers are written down rather than random, so the screen
 * a judge waits on is the same one every time, and the lit windows are the only warm
 * thing above the horizon.
 */
const TOWERS: [number, number, number][] = [
  [0, 46, 86],
  [42, 30, 132],
  [70, 54, 62],
  [120, 38, 158],
  [155, 26, 104],
  [178, 62, 186],
  [236, 34, 120],
  [266, 44, 74],
  [306, 30, 148],
  [332, 58, 98],
  [386, 40, 170],
  [422, 34, 66],
  [452, 48, 126],
  [496, 44, 90],
];

/** Lit windows, worked out from the towers so one can never hang in the sky. */
const WINDOWS: [number, number][] = TOWERS.flatMap(([x, width, height], tower) => {
  const rows = Math.max(1, Math.floor((height - 18) / 15));
  const columns = Math.max(1, Math.floor((width - 8) / 12));
  const lit: [number, number][] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if ((tower * 5 + row * 3 + column * 7) % 5 > 1) continue;
      lit.push([x + 6 + column * 12, 200 - height + 12 + row * 15]);
    }
  }
  return lit;
});

function Skyline({ reduced }: { reduced: boolean }) {
  return (
    <motion.div
      aria-hidden
      data-testid="skyline"
      initial={{ opacity: 0, y: 26 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 1.1, ease: EASE, delay: 0.15 }}
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[52svh] max-h-[440px] min-h-[220px]"
    >
      <span
        className="absolute inset-x-0 top-0 h-32 -translate-y-1/2"
        style={{
          background:
            "radial-gradient(70% 100% at 50% 100%, rgba(255,106,43,0.22) 0%, rgba(255,106,43,0) 70%)",
        }}
      />
      <svg
        viewBox="0 0 540 200"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          <linearGradient id="vettai-tower" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2b3a63" />
            <stop offset="100%" stopColor="#111a2e" />
          </linearGradient>
        </defs>
        {TOWERS.map(([x, width, height]) => (
          <rect key={`${x}`} x={x} y={200 - height} width={width} height={height} fill="url(#vettai-tower)" />
        ))}
        {WINDOWS.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={6} height={2} fill="#ff6a2b" opacity="0.75" />
        ))}
      </svg>
      <span
        className="absolute inset-x-0 bottom-0 h-2/3"
        style={{ background: "linear-gradient(to top, #0b0f1a 12%, rgba(11,15,26,0) 100%)" }}
      />
    </motion.div>
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
