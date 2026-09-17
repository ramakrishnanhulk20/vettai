"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  getHealth,
  getLadderWeek,
  getQuestsToday,
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
import { nim, refusalText, shortAddress, type Network } from "./format";
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
 * How long the way in stays quiet before it shows the deep link. The wallet answers in a
 * second or two inside Nimiq Pay; a browser never answers at all, and a judge who opened
 * the link on a laptop used to watch a progress dot for sixteen seconds before being told
 * anything. The wait above carries on underneath, so a wallet that turns up still boots.
 */
const PROVIDER_HINT_MS = 2500;

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

/** How long the world keeps a downed player on the ground, DOWNED_MS in the simulation. */
const DOWNED_MS = 3000;

/** How often the week's standing is read while the hunt is finished. It moves slowly. */
const LADDER_MS = 60_000;

/** How long the note about the no-fire circle holds after a refused trigger pull. */
const OFFICE_NOTE_MS = 3600;

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
  /** Read on the trigger pull, never rendered: inside the circle the world refuses the shot. */
  const insideSafeRef = useRef(false);
  const officeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  /** True once the provider wait has gone on long enough to show the way in by hand. */
  const [waitedForWallet, setWaitedForWallet] = useState(false);
  /** True when this page is running inside Nimiq Pay, which changes what a missing wallet means. */
  const [insidePay, setInsidePay] = useState(false);

  const [shield, setShield] = useState(3);
  const [quests, setQuests] = useState<QuestView[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aimHot, setAimHot] = useState(false);
  /** True while the drone a shot would take is off the top of the screen. */
  const [aimAbove, setAimAbove] = useState(false);
  /** True for a few seconds after the office circle refused a trigger pull. */
  const [officeNote, setOfficeNote] = useState(false);
  const [firedAt, setFiredAt] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  /** Where the player stood when that prompt appeared, which is what its distances mean. */
  const [promptAt, setPromptAt] = useState<{ x: number; z: number } | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [hitAt, setHitAt] = useState(0);
  /** When the body gets up again, as a clock reading, or 0 while the player is on their feet. */
  const [downedUntil, setDownedUntil] = useState(0);

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

  // Where this wallet stands on the week, asked for only once the day's hunt is finished:
  // before that the strip has a target to count towards and the ladder is not the story.
  const [weekPlace, setWeekPlace] = useState<number | null>(null);
  const huntQuest = quests.find((quest) => quest.kind === "hunt") ?? null;
  const huntDone = huntQuest !== null && huntQuest.state !== "open";
  const huntKills = huntQuest?.progress ?? 0;
  const huntStanding = useMemo(
    () => (huntDone ? { count: huntKills, rank: weekPlace } : null),
    [huntDone, huntKills, weekPlace],
  );

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

  // The ladder publishes ten places and shortens the addresses on the way out, so a wallet
  // outside those ten cannot be found in it. The strip then shows the kill count on its own
  // rather than inventing a position for it.
  useEffect(() => {
    if (!playing || !huntDone || address === "") return;
    let alive = true;
    const mine = shortAddress(address);
    const read = () => {
      void getLadderWeek().then((result) => {
        if (!alive || !result.ok) return;
        const row = result.data.entries.find((entry) => entry.address === mine);
        setWeekPlace(row ? row.place : null);
      });
    };
    read();
    const timer = setInterval(read, LADDER_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [address, huntDone, playing]);

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
    if (officeTimer.current) clearTimeout(officeTimer.current);
  }, []);

  /**
   * The trigger was pulled inside the office circle. The world refuses every shot from in
   * there, so nothing is drawn and nothing is sent: the player is told the rule instead.
   */
  const noteOffice = useCallback(() => {
    setOfficeNote(true);
    if (officeTimer.current) clearTimeout(officeTimer.current);
    officeTimer.current = setTimeout(() => setOfficeNote(false), OFFICE_NOTE_MS);
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

  /** Reads the day's jobs again, which is what a rolled-over day needs from every screen. */
  const refreshQuests = useCallback(async () => {
    const result = await getQuestsToday();
    if (!result.ok) return;
    setCarryUntil(null);
    questsRef.current = result.data.quests;
    setQuests(result.data.quests);
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
        // Three readings off one frame, and not one of them may render React sixty times a
        // second: the two booleans settle to the same value most frames, and where the
        // player is standing is only ever read on a trigger pull.
        onAim: (hot, crosshair) => {
          setAimHot(hot);
          setAimAbove(crosshair.droneAboveView);
          insideSafeRef.current = crosshair.insideSafeCircle;
        },
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
          // The overlay holds for as long as the body is down, so the screen never looks
          // like a normal one while the stick does nothing.
          if (event.kind === "downed") return setDownedUntil(Date.now() + DOWNED_MS);
          if (event.kind === "respawn") return setDownedUntil(0);
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
          // Inside the circle the world refuses the shot. Drawing the tracer and kicking the
          // trigger anyway is the game pretending it fired, which is how a judge standing on
          // the office door decides the fire button is broken.
          if (insideSafeRef.current) {
            noteOffice();
            lessonDone(1);
            return;
          }
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

          // Three things the world says that the scene has no way of showing: a kill
          // somebody else was credited with, a parcel that is back where it started, and
          // a day that turned over while this player was still standing in the street.
          for (const event of frame.events) {
            if (event.kind === "assist") {
              toast("Assist: your shot finished it");
            }
            if (event.kind === "courier-reset") {
              setCarryUntil(null);
              toast(
                event.reason === "cold"
                  ? "Parcel went cold, pick it up again"
                  : "New day, new route",
              );
            }
            if (event.kind === "quests-rolled") {
              toast("A new day's jobs are up");
              void refreshQuests();
            }
          }

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
            // A refusal with nothing to do at this spot carries the job the player is
            // actually being pointed at, so the toast ends on the next step.
            const nextStep =
              frame.code === "nothing to do" ? (objectiveRef.current?.sentence ?? null) : null;
            toast(refusalText(frame.code, nextStep));
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
  }, [announce, attempt, lessonDone, noteOffice, openSheet, reduced, refreshQuests, toast]);

  // A respawn frame that never arrives must not leave the screen lying on the floor, so
  // the overlay lets go a few seconds after the world said the body would be back up.
  useEffect(() => {
    if (downedUntil === 0) return;
    const timer = setTimeout(
      () => setDownedUntil(0),
      Math.max(0, downedUntil - Date.now()) + 4000,
    );
    return () => clearTimeout(timer);
  }, [downedUntil]);

  // Nothing is drawn while a panel owns the screen. A phone that is waiting to connect or
  // has lost its picture should not be spending its battery on frames nobody sees.
  useEffect(() => {
    setLoop.current(playing);
  }, [playing]);

  // Two and a half seconds into the wait the panel stops saying "looking" and starts
  // saying what to do, while the wallet is still being looked for underneath.
  useEffect(() => {
    if (phase.name !== "provider") return;
    setWaitedForWallet(false);
    const timer = setTimeout(() => setWaitedForWallet(true), PROVIDER_HINT_MS);
    return () => clearTimeout(timer);
  }, [phase.name, attempt]);

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
   *
   * The eight seconds only run while somebody is watching. A phone taking a call is not a
   * world that will not answer, and a player used to come back to a dead end that was
   * decided while the screen was off.
   */
  useEffect(() => {
    if (phase.name !== "connecting" && phase.name !== "reconnecting") return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setTimeout(() => {
        setPhase({
          name: "error",
          title: "The city did not answer",
          body: "The world server took the connection but never handed over a room. Tap below to try again.",
        });
      }, WELCOME_WAIT_MS);
    };

    const watch = () => (document.hidden ? stop() : start());
    watch();
    document.addEventListener("visibilitychange", watch);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", watch);
    };
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
        data-testid="surface"
        className={`absolute inset-0 select-none ${sheet ? "pointer-events-none" : "touch-none"}`}
        style={{ touchAction: "none" }}
      />

      {playing && (
        <Hud
          shield={shield}
          quests={quests}
          objective={objective}
          hunt={huntStanding}
          carryUntil={carryUntil}
          toasts={toasts}
          latency={latency}
          aimHot={aimHot}
          aimAbove={aimAbove}
          officeNote={officeNote}
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
          downedUntil={downedUntil}
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
            {/* The same allowance the compass carries: inside Nimiq Pay the wallet's own
                bar sits above this page and the inset does not know about it. */}
            <div className="label-type absolute inset-x-0 top-0 flex items-center justify-between gap-3 border-b border-line px-6 pb-3 pt-[calc(env(safe-area-inset-top)+3rem)] text-paper/35">
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
              className="absolute left-6 top-[calc(env(safe-area-inset-top)+6.4rem)] flex items-center gap-3"
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
              phase={phase.name === "provider" && waitedForWallet ? { name: "outside" } : phase}
              stillLooking={phase.name === "provider" && waitedForWallet}
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
  // The point's number means nothing to anybody, so the line carries the distance.
  const wanted = carrying ? courier.route.to : courier.route.from;
  const spot = map?.courier[wanted] ?? null;
  const away = spot && at ? ` ${metres(groundRange(at, spot))} away` : " at the other point";
  return {
    kind: "note",
    text: `Not this one. ${carrying ? "Drop it" : "Pick it up"}${away}`,
  };
}

/**
 * The first minute, and only ever the first. Three lines, each one dismissed by doing the
 * thing it asks for, by tapping it, or by six seconds passing. Everything but the words is
 * left clickable, so the lesson can be finished with the thumb it is teaching.
 *
 * The timer is the important one. Card three used to wait for the board to be opened, so a
 * player who only ever shot spent the whole session reading it, and the city behind it was
 * dimmed the entire time.
 */
const LESSON_MS = 6000;

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

  // Reads the live handler off a ref so the six seconds are not restarted every time the
  // screen re-renders around it, which on this HUD is a couple of times a second.
  const tap = useRef(onTap);
  tap.current = onTap;
  useEffect(() => {
    if (!words) return;
    const timer = setTimeout(() => tap.current(), LESSON_MS);
    return () => clearTimeout(timer);
  }, [lesson, words]);

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
      {/* A wash, not a blackout. The lesson is about the city, so the city has to be the
          brightest thing on screen while it is read, and the shield bars and the quest
          strip under here have to stay legible. The words carry their own shadow instead. */}
      <div
        aria-hidden
        data-testid="first-minute-scrim"
        className="absolute inset-0"
        style={{
          background: `radial-gradient(70% 45% at ${glow}, rgba(255,106,43,0.14) 0%, rgba(11,15,26,0.28) 45%, rgba(11,15,26,0.35) 100%)`,
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
          style={{ textShadow: "0 2px 22px rgba(11,15,26,0.95), 0 0 6px rgba(11,15,26,0.8)" }}
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
  /** The wallet is still being looked for behind this panel, so the wait says so. */
  stillLooking: boolean;
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
    body: "The bounty is paid in NIM straight to your wallet, so Vettai runs inside Nimiq Pay. Open this link on the phone that has the app.",
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

function Panel({
  phase,
  stillLooking,
  reduced,
  deepLink,
  copied,
  insidePay,
  onCopy,
  onRetry,
}: PanelProps) {
  const words =
    phase.name === "error"
      ? { label: "Stopped", title: phase.title, body: phase.body }
      : phase.name === "outside" && insidePay
        ? STARTING_UP
        : COPY[phase.name];
  if (!words) return null;

  const status = stillLooking ? "still looking for the wallet" : statusOf(phase);

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

        {/* One thing to do, and one quiet way to move the link to a phone. Nothing here
            asks the player to try again: the page is already looking on its own. */}
        {phase.name === "outside" && !insidePay && (
          <div className="mt-5 flex flex-col items-start gap-1">
            <a
              href={deepLink}
              data-testid="open-in-pay"
              className="w-full rounded-btn bg-hunt px-5 py-4 text-center font-medium text-night transition-transform duration-300 hover:scale-[1.02] active:scale-[0.99] sm:w-auto sm:px-8"
            >
              Open in Nimiq Pay
            </a>
            <button
              type="button"
              onClick={onCopy}
              data-testid="copy-link"
              className={`inline-flex items-center text-[0.875rem] text-paper/55 underline decoration-line underline-offset-4 transition-colors duration-300 hover:text-paper hover:decoration-hunt ${styles.tap}`}
            >
              {copied ? "Link copied" : "Copy the link instead"}
            </button>
          </div>
        )}

        {(phase.name === "cancelled" || phase.name === "error") && (
          <button
            type="button"
            onClick={onRetry}
            data-testid="try-again"
            className="rounded-btn bg-hunt px-5 py-4 font-medium text-night transition-transform duration-300 hover:scale-[1.02] active:scale-[0.99]"
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
