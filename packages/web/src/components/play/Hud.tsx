"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { QuestView } from "@/lib/api";
import type { Objective } from "@/game/markers";
import type { Readout } from "@/game/world";
import { isMuted, play, setMuted, unlockAudio } from "@/game/audio";
import Compass from "./Compass";
import styles from "./play.module.css";

/**
 * Everything drawn over the city: what the player has left, what the day asks of them,
 * where they are aiming and what just happened. Nothing here is decided on the phone. The
 * shield, the quest numbers and the events all come off the socket.
 *
 * The one thing drawn ahead of the server is the shot: the tracer in the scene and the
 * kick on this crosshair happen on the trigger pull, because half a second of waiting for
 * a hit to come back reads as a broken button. What was actually hit still comes back.
 */

export type Toast = { id: string; text: string };

/**
 * What the place under the player's feet offers. A `do` is a button; a `note` is a line
 * that answers "why is there no button here" without the server ever being asked.
 */
export type PromptAction =
  | { kind: "do"; text: string; primary: boolean }
  | { kind: "note"; text: string };

/** What the round trip number opens: everything the phone knows about its own frame. */
export type Panel = Readout & { latency: number | null; jitter: number | null };

/**
 * Bumped by hand whenever a build goes out to a phone, so a screenshot of the readout
 * says which build it came from.
 */
const BUILD = "vettai-2026-09-16-c";

/** How often the open panel reads the world. Twice a second is legible and near free. */
const PANEL_MS = 500;

export type HudProps = {
  shield: number;
  quests: QuestView[];
  /** The one thing to do next. The sentence comes from React, the metres from the frame. */
  objective: Objective | null;
  /**
   * This week's kills and where they stand, once today's hunt is finished. Null while the
   * hunt is still open. `rank` is null when the wallet is outside the ten places the ladder
   * publishes, and the strip then shows the count alone.
   */
  hunt: { count: number; rank: number | null } | null;
  /** When a carried parcel goes cold, as a clock reading, or null when nothing is carried. */
  carryUntil: number | null;
  toasts: Toast[];
  latency: number | null;
  aimHot: boolean;
  /** True when the drone the shot would take is above the top of the screen. */
  aimAbove: boolean;
  /** True for a few seconds after a trigger pull the office circle refused. */
  officeNote: boolean;
  /** The moment of the last shot this phone drew, which kicks the crosshair. */
  firedAt: number;
  /** The action for the place the player is standing on, accent when it is the objective. */
  prompt: PromptAction | null;
  onInteract: () => void;
  /** The quest strip leads to the board, and so does the action button at the door. */
  onOpenBoard: () => void;
  /** Claims the treasury has not finished sending yet. */
  payouts: number;
  /** Claims the treasury is holding, which the board explains in full. */
  held: number;
  /** True when the hold is the pool running dry rather than a cap that lifts at midnight. */
  heldOnPool: boolean;
  /** The moment the last payout landed, which flashes the shield bars. */
  paidAt: number;
  attachFire: (button: HTMLElement | null) => void;
  /** The moment the last shield bar was lost, which flashes the edge of the screen. */
  hitAt: number;
  /** When the body gets up again, as a clock reading, or 0 while the player is on their feet. */
  downedUntil: number;
  /** While a panel is up the thumb belongs to the panel, so the controls step back. */
  sheetOpen: boolean;
  reduced: boolean;
  /** Read on a timer while the readout is open, never on a frame. */
  readout?: () => Panel | null;
};

const MAX_SHIELD = 3;

function questTitle(kind: QuestView["kind"]): string {
  if (kind === "hunt") return "Hunt";
  if (kind === "courier") return "Courier";
  if (kind === "landmarks") return "Landmarks";
  if (kind === "landlord") return "Landlord";
  return "Streak";
}

/**
 * What the job the objective is pointing at pays, in NIM, as the server wrote it on the
 * quest row. Empty when the objective is not a job or when today has nothing left to pay
 * on it, because a "0 NIM" on the street would be worse than saying nothing.
 */
function objectiveReward(objective: Objective | null, quests: QuestView[]): string {
  if (!objective || objective.questId === null) return "";
  const quest = quests.find((row) => row.id === objective.questId);
  if (!quest || Number(quest.rewardLuna) <= 0) return "";
  return quest.rewardNim;
}

/** 3 becomes "3rd". The ladder's places are read out loud by everybody who sees them. */
function ordinal(place: number): string {
  const tens = place % 100;
  if (tens >= 11 && tens <= 13) return `${place}th`;
  const last = place % 10;
  if (last === 1) return `${place}st`;
  if (last === 2) return `${place}nd`;
  if (last === 3) return `${place}rd`;
  return `${place}th`;
}

function questCount(quest: QuestView): string {
  if (quest.kind === "landmarks" && quest.visited) {
    return `${quest.visited.filter(Boolean).length}/${quest.target}`;
  }
  return `${Math.min(quest.progress, quest.target)}/${quest.target}`;
}

export default function Hud({
  shield,
  quests,
  objective,
  hunt,
  carryUntil,
  toasts,
  latency,
  aimHot,
  aimAbove,
  officeNote,
  firedAt,
  prompt,
  onInteract,
  onOpenBoard,
  payouts,
  held,
  heldOnPool,
  paidAt,
  attachFire,
  hitAt,
  downedUntil,
  sheetOpen,
  reduced,
  readout,
}: HudProps) {
  const claimable = quests.some((quest) => quest.state === "done" && Number(quest.rewardLuna) > 0);
  const downed = downedUntil > 0;
  const [openReadout, setOpenReadout] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [copied, setCopied] = useState(false);
  // Read after the mount, never during it: the first paint comes off the server and this
  // phone's answer lives in its own storage.
  const [quiet, setQuiet] = useState(false);
  useEffect(() => setQuiet(isMuted()), []);

  const toggleSound = useCallback(() => {
    const next = !isMuted();
    // The tap that turns the sound back on is also the gesture the phone wants before it
    // will make any sound at all, so the speaker is opened here as well.
    unlockAudio();
    setMuted(next);
    setQuiet(next);
    if (!next) play("tap");
  }, []);

  useEffect(() => {
    if (!openReadout || !readout) return;
    const read = () => setPanel(readout());
    read();
    const timer = setInterval(read, PANEL_MS);
    return () => clearInterval(timer);
  }, [openReadout, readout]);

  const copyReadout = useCallback(() => {
    if (!panel) return;
    try {
      void navigator.clipboard?.writeText(readoutText(panel)).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      });
    } catch {
      // A WebView with no clipboard is not a reason to break the game.
    }
  }, [panel]);

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      <AnimatePresence>
        {hitAt > 0 && (
          <motion.div
            key={hitAt}
            aria-hidden
            initial={{ opacity: reduced ? 0.5 : 0.9 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
            className="absolute inset-0"
            style={{ boxShadow: "inset 0 0 120px 24px rgba(255,77,109,0.75)" }}
          />
        )}
      </AnimatePresence>

      {/* The street behind the top of the screen can be a lit shop sign, and white type on
          a lit shop sign is nothing at all. Everything up here sits on this. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-44"
        style={{
          background:
            "linear-gradient(to bottom, rgba(11,15,26,0.78) 0%, rgba(11,15,26,0.42) 46%, rgba(11,15,26,0) 100%)",
        }}
      />

      <Compass reduced={reduced} />

      <div className="absolute left-4 top-[max(3.1rem,calc(env(safe-area-inset-top)+2.6rem))] flex flex-col gap-2">
        <div key={paidAt} className={`flex gap-1.5 ${paidAt > 0 ? styles.payoutPulse : ""}`}>
          {Array.from({ length: MAX_SHIELD }, (_, index) => (
            <motion.span
              key={index}
              animate={{
                opacity: index < shield ? 1 : 0.22,
                scaleY: index < shield ? 1 : 0.7,
              }}
              transition={{ duration: reduced ? 0 : 0.25, ease: "easeOut" }}
              className="block h-3 w-8 origin-bottom -skew-x-12 border border-hunt"
              style={{ background: index < shield ? "var(--hunt)" : "transparent" }}
            />
          ))}
        </div>
        <span className="label-type text-paper/70">Shield</span>
        <Objective
          objective={objective}
          reward={objectiveReward(objective, quests)}
          carryUntil={carryUntil}
          reduced={reduced}
        />
      </div>

      <div className="absolute right-4 top-[max(3.1rem,calc(env(safe-area-inset-top)+2.6rem))] flex w-44 flex-col items-end gap-1">
        {/* The day's jobs wear the same plate the objective line wears. Only the header is
            a button: the rows underneath let a look-swipe through to the street, which is
            the control that lives in this half of the screen. */}
        <div
          data-testid="quest-strip"
          className={`flex w-full flex-col items-end gap-1.5 border-r-2 border-hunt bg-night/55 py-2 pl-3 pr-2.5 text-right backdrop-blur-sm transition-opacity duration-300 ${
            sheetOpen ? "opacity-30" : "opacity-100"
          } ${styles.strip}`}
        >
          <button
            type="button"
            onClick={onOpenBoard}
            data-testid="hud-quests"
            aria-label="Open the day's jobs"
            className={`pointer-events-auto flex w-full items-center justify-end ${styles.action} ${
              claimable ? "text-hunt" : "text-paper/70"
            }`}
          >
            {claimable ? "Today, claim" : "Today"}
          </button>

          <div className="pointer-events-none flex w-full flex-col items-end gap-1.5">
            {quests.map((quest) => {
              // The hunt is the one job that keeps counting past its target, and that count
              // is what the weekly ladder pays on, so the row stops saying "done" the moment
              // there is a real number to show instead.
              const kills = quest.kind === "hunt" && quest.state !== "open" ? hunt : null;
              return (
                <motion.span
                  key={quest.id}
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: reduced ? 0 : 0.4, ease: "easeOut" }}
                  className="flex w-full flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5"
                >
                  <span
                    className={`label-type ${quest.state === "open" ? "text-paper/70" : "text-hunt"}`}
                  >
                    {questTitle(quest.kind)}
                  </span>
                  <span className="font-mono text-xs text-paper/85" data-testid={`strip-${quest.kind}`}>
                    {quest.state === "open"
                      ? questCount(quest)
                      : kills
                        ? `${kills.count} ${kills.count === 1 ? "kill" : "kills"}`
                        : "done"}
                  </span>
                  {quest.state !== "open" && (
                    <span aria-hidden className="text-xs leading-none text-hunt">
                      &#10003;
                    </span>
                  )}
                  {kills?.rank && (
                    <span
                      className="w-full font-mono text-[11px] text-hunt"
                      data-testid="hunt-rank"
                    >
                      {ordinal(kills.rank)} this week
                    </span>
                  )}
                </motion.span>
              );
            })}
            {payouts > 0 && (
              <span className="mt-1 font-mono text-[11px] text-hunt" data-testid="payouts-line">
                {payouts === 1 ? "1 payout on its way" : `${payouts} payouts on their way`}
              </span>
            )}
            {held > 0 && (
              <span className="mt-1 font-mono text-[11px] text-paper/80" data-testid="held-line">
                {held === 1 ? "1 payout held" : `${held} payouts held`}
                {heldOnPool ? ", the prize pool is empty" : " until tomorrow"}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {latency !== null && (
            <button
              type="button"
              onClick={() => setOpenReadout((was) => !was)}
              data-testid="latency"
              aria-label="Show what this phone is doing"
              aria-expanded={openReadout}
              className={`pointer-events-auto font-mono text-[14px] tracking-wide transition-colors duration-200 hover:text-hunt ${styles.tap} ${
                openReadout ? "text-hunt" : "text-paper/60"
              }`}
            >
              {latency} ms
            </button>
          )}
          <Sound quiet={quiet} reduced={reduced} onToggle={toggleSound} />
        </div>
        {latency !== null && latency > 250 && (
          <span className="font-mono text-[11px] text-paper/60" data-testid="far-note">
            slow line to the server
          </span>
        )}
      </div>

      {/* The instrument panel lives on the left, under the shield, and is held short of the
          middle of the screen: the crosshair is the one thing it may never sit on. */}
      <AnimatePresence>
        {openReadout && (
          <motion.div
            key="readout"
            data-testid="readout"
            initial={{ opacity: 0, y: reduced ? 0 : -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : -8 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: "easeOut" }}
            className={`pointer-events-auto absolute left-4 top-[max(9.4rem,calc(env(safe-area-inset-top)+8.9rem))] flex max-h-[calc(46svh-9.4rem)] w-max max-w-[62%] flex-col overflow-hidden border border-line bg-night/85 p-2.5 text-left backdrop-blur-sm ${styles.readout}`}
          >
            {/* The list scrolls, the copy button does not: the one thing this panel is for
                is handing a reading to somebody else. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panel === null ? (
                <p className="font-mono text-[11px] text-paper/50">reading the frame</p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] font-mono text-[11px] leading-tight">
                  {readoutRows(panel).map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-paper/55">{label}</dt>
                      <dd className="truncate text-right text-paper/90">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            <button
              type="button"
              onClick={copyReadout}
              data-testid="readout-copy"
              className={`mt-2 flex w-full shrink-0 items-center justify-center border border-line px-2 text-paper/70 transition-colors duration-200 hover:border-hunt hover:text-paper ${styles.action}`}
            >
              {copied ? "copied" : "copy"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pointer-events-none absolute inset-x-0 top-[max(9.5rem,calc(env(safe-area-inset-top)+9rem))] flex flex-col items-center gap-2 px-6">
        <AnimatePresence initial={false}>
          {toasts.map((item) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: reduced ? 0 : 0.28, ease: "easeOut" }}
              className="rounded-btn border border-line bg-night/70 px-3 py-1.5 text-sm text-paper backdrop-blur-sm"
            >
              {item.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {!sheetOpen && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <Crosshair hot={aimHot} firedAt={firedAt} reduced={reduced} />
        </div>
      )}

      <AnimatePresence>
        {aimHot && !sheetOpen && <AimRing key="aim-ring" reduced={reduced} />}
      </AnimatePresence>

      <AnimatePresence>
        {aimAbove && !sheetOpen && !downed && <Overhead key="overhead" reduced={reduced} />}
      </AnimatePresence>

      {/* The one rule in this city nothing on screen used to mention. It is said at the
          moment it bites, which is the trigger pull, and it says where to go. */}
      <AnimatePresence>
        {officeNote && !sheetOpen && (
          <motion.p
            key="office-note"
            data-testid="office-note"
            initial={{ opacity: 0, y: reduced ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.25, ease: "easeOut" }}
            className="absolute inset-x-0 top-[calc(50%+2.6rem)] mx-auto w-max max-w-[86%] rounded-btn border border-hunt/50 bg-night/80 px-4 py-2.5 text-center text-sm text-paper backdrop-blur"
          >
            No shooting at the office. Step outside the ring.
          </motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {prompt && !sheetOpen && (
          <motion.div
            key={prompt.text}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
            className="absolute inset-x-0 bottom-[max(9.5rem,calc(env(safe-area-inset-bottom)+8.5rem))] flex items-center justify-center gap-2 px-6"
          >
            {prompt.kind === "do" ? (
              <button
                type="button"
                onClick={onInteract}
                data-testid="interact"
                className={`pointer-events-auto flex min-h-[56px] items-center rounded-btn px-6 text-base backdrop-blur transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98] ${
                  prompt.primary
                    ? "bg-hunt font-medium text-night shadow-[0_14px_38px_rgba(255,106,43,0.35)]"
                    : "border border-hunt bg-night/80 text-paper hover:bg-hunt hover:text-night"
                }`}
              >
                {prompt.text}
              </button>
            ) : (
              <span
                data-testid="prompt-note"
                className="label-type rounded-btn border border-line bg-night/70 px-4 py-3 text-paper/60 backdrop-blur"
              >
                {prompt.text}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>{downed && <Downed until={downedUntil} reduced={reduced} />}</AnimatePresence>

      <motion.button
        type="button"
        ref={attachFire}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{
          opacity: sheetOpen ? 0 : downed ? 0.3 : 1,
          scale: sheetOpen ? 0.9 : 1,
        }}
        transition={{ duration: reduced ? 0 : 0.35, ease: "easeOut" }}
        whileTap={reduced || downed ? undefined : { scale: 0.92 }}
        onPointerDown={unlockAudio}
        onTouchStart={unlockAudio}
        aria-label="Fire"
        aria-hidden={sheetOpen}
        data-testid="fire"
        className={`absolute bottom-[max(2.5rem,calc(env(safe-area-inset-bottom)+1.5rem))] right-6 flex h-[72px] w-[72px] items-center justify-center rounded-full border-2 border-hunt bg-hunt/15 text-hunt backdrop-blur-sm transition-colors duration-200 hover:bg-hunt/30 ${styles.action} ${
          sheetOpen || downed ? "pointer-events-none" : "pointer-events-auto"
        }`}
        style={{ touchAction: "none" }}
      >
        {firedAt > 0 && (
          <motion.span
            key={firedAt}
            aria-hidden
            initial={{ opacity: reduced ? 0 : 0.85, scale: 1 }}
            animate={{ opacity: 0, scale: 1.45 }}
            transition={{ duration: reduced ? 0 : 0.25, ease: "easeOut" }}
            className="absolute inset-0 rounded-full border-2 border-hunt"
          />
        )}
        Fire
      </motion.button>
    </div>
  );
}

/**
 * The speaker. One 44 pixel box, the accent when the city is making noise and a slash
 * across it when it is not. What it says is remembered on this phone, so a player who
 * turned the sound off once never has to do it again.
 */
function Sound({
  quiet,
  reduced,
  onToggle,
}: {
  quiet: boolean;
  reduced: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      whileTap={reduced ? undefined : { scale: 0.9 }}
      data-testid="mute"
      aria-label={quiet ? "Turn the sound on" : "Turn the sound off"}
      aria-pressed={quiet}
      className={`pointer-events-auto ${styles.tap} ${styles.mute} ${
        quiet ? "text-paper/45" : "text-hunt"
      }`}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M3 7.5h3L10.5 4v12L6 12.5H3z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        {quiet ? (
          <path d="M14 7l4 6M18 7l-4 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
        ) : (
          <>
            <path d="M13.4 7.2a4 4 0 0 1 0 5.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
            <path d="M15.8 5.2a7 7 0 0 1 0 9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" opacity="0.6" />
          </>
        )}
      </svg>
    </motion.button>
  );
}

/**
 * Three seconds on the ground, held on screen for every one of them. The number is the
 * whole message: the game has not broken, and this is how long until the stick answers
 * again. A toast that outlived two and a half of those seconds left the screen looking
 * exactly like a working one.
 */
function Downed({ until, reduced }: { until: number; reduced: boolean }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  const left = Math.max(0, until - now);
  const seconds = Math.ceil(left / 1000);

  return (
    <motion.div
      key="downed"
      data-testid="downed"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.25, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center bg-night/72 px-8 text-center backdrop-blur-[2px]"
    >
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 55% at 50% 50%, rgba(255,77,109,0.22) 0%, rgba(11,15,26,0) 70%)",
        }}
      />
      <span className="label-type relative text-bad">Downed</span>
      {seconds > 0 ? (
        <>
          <motion.span
            key={seconds}
            initial={{ opacity: 0, scale: reduced ? 1 : 1.25 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
            className="display-type relative mt-2 leading-[0.8] text-paper"
            style={{ fontSize: "clamp(5rem,26vw,9rem)" }}
          >
            {seconds}
          </motion.span>
          <span className="relative mt-3 text-base text-paper/70">
            Back on your feet in {seconds} {seconds === 1 ? "second" : "seconds"}
          </span>
        </>
      ) : (
        <span className="display-type relative mt-3 text-[clamp(2rem,9vw,3rem)] uppercase leading-none tracking-[-0.02em] text-paper">
          Getting you up
        </span>
      )}
    </motion.div>
  );
}

/**
 * The line that answers "what now". The words change only when the job changes, so they
 * come from React; the metres change every frame, so they arrive as a CSS variable the
 * render loop writes and this span prints. Nothing here renders sixty times a second.
 */
function Objective({
  objective,
  reward,
  carryUntil,
  reduced,
}: {
  objective: Objective | null;
  /** What this job pays, in NIM, straight off the quest row. Empty when it pays nothing. */
  reward: string;
  carryUntil: number | null;
  reduced: boolean;
}) {
  const elsewhere = objective !== null && !objective.spots.includes("courier");
  return (
    <AnimatePresence mode="wait">
      {objective && (
        <motion.div
          key={objective.sentence}
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -6 }}
          transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
          data-testid="objective"
          className={`mt-0.5 max-w-[calc(100vw-13rem)] border-l-2 border-hunt bg-night/55 py-1.5 pl-2.5 pr-3 backdrop-blur-sm ${styles.objective}`}
        >
          {/* The money is the whole point of walking anywhere, so it sits in the sentence
              rather than one tap away on the board. The line runs as text rather than as a
              row of boxes: on a 390 pixel screen the job wraps, and the amount and the
              metres have to land together under it, not one orphan each. */}
          <p className="display-type text-[1.05rem] uppercase leading-tight tracking-[0.01em] text-paper">
            {objective.sentence}
            {reward !== "" && ","}
          </p>
          {/* The amount and the metres are one reading and they stay one line. The job above
              is what wraps on a 390 pixel screen, and it may not drag the money with it. */}
          <p className="mt-0.5">
            {reward !== "" && (
              <span data-testid="objective-reward" className={styles.reward}>
                {reward} NIM
              </span>
            )}
            {/* The space is load bearing: without it the amount and the metres are one
                unbreakable run and a long walk pushes the metres off the plate. */}
            {reward !== "" && " "}
            <span aria-hidden data-testid="objective-range" className={styles.range} />
          </p>
          {carryUntil !== null && <Countdown until={carryUntil} dim={elsewhere} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The parcel's two minutes, counted down once a second. It goes red in the last twenty,
 * and steps back to a whisper while the player is being pointed at a different job.
 */
function Countdown({ until, dim }: { until: number; dim: boolean }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const left = Math.max(0, until - now);
  const seconds = Math.ceil(left / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <span
      data-testid="carry-clock"
      className={`label-type mt-1 block ${left <= 20_000 ? "text-bad" : "text-hunt"}`}
      style={{ opacity: dim ? 0.6 : 1 }}
    >
      {left === 0 ? "the parcel went cold, pick it up again" : `${clock} left on the parcel`}
    </span>
  );
}

function readoutRows(panel: Panel): [string, string][] {
  return [
    ["fps", String(panel.fps)],
    ["frame", `${panel.frameMs.toFixed(1)} ms`],
    ["drawing", `${panel.workMs.toFixed(1)} ms`],
    ["round trip", panel.latency === null ? "waiting" : `${panel.latency} ms`],
    ["jitter", panel.jitter === null ? "waiting" : `${panel.jitter} ms`],
    ["off server", `${panel.errorMetres.toFixed(2)} m`],
    ["intents", `${panel.sendRate}/s`],
    ["draw calls", String(panel.calls)],
    ["triangles", String(panel.triangles)],
    [
      "canvas",
      `${panel.width}x${panel.height} @${panel.pixelRatio.toFixed(2)} (${panel.bufferWidth}x${panel.bufferHeight})`,
    ],
    ["webgl", String(panel.webgl)],
    ["gpu", panel.gpu],
    ["build", BUILD],
    ["mode", panel.reliefMode ? "performance mode" : "full"],
  ];
}

function readoutText(panel: Panel): string {
  return readoutRows(panel)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

/**
 * The ring around the drone a tap would shoot, parked on the screen position the world
 * publishes as CSS variables every frame. Reading them here means the aim can follow a
 * moving drone without React rendering a single extra time.
 */
function AimRing({ reduced }: { reduced: boolean }) {
  return (
    <div
      aria-hidden
      data-testid="aim-ring"
      className="absolute left-0 top-0"
      style={{
        width: "var(--aim-size, 56px)",
        height: "var(--aim-size, 56px)",
        opacity: "var(--aim-on, 0)",
        transform:
          "translate3d(calc(var(--aim-x, -400px) - 50%), calc(var(--aim-y, -400px) - 50%), 0)",
        willChange: "transform",
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 1.45 }}
        animate={{ opacity: 1, scale: 1, rotate: reduced ? 0 : 90 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{
          opacity: { duration: reduced ? 0 : 0.18 },
          scale: { duration: reduced ? 0 : 0.22, ease: "easeOut" },
          rotate: { duration: reduced ? 0 : 9, ease: "linear", repeat: Infinity },
        }}
        className="relative h-full w-full"
      >
        <span className="absolute inset-0 rounded-full border border-hunt/45" />
        {[
          "left-0 top-0 border-l-2 border-t-2",
          "right-0 top-0 border-r-2 border-t-2",
          "bottom-0 left-0 border-b-2 border-l-2",
          "bottom-0 right-0 border-b-2 border-r-2",
        ].map((corner) => (
          <span key={corner} className={`absolute h-3 w-3 border-hunt ${corner}`} />
        ))}
      </motion.div>
    </div>
  );
}

/**
 * The drone the shot would take is off the top of the screen. An engaged drone closes to
 * six metres and hangs six up, so the fight happens above the roofline of the crosshair and
 * a player with no arrow to follow reads it as being shot by nothing.
 */
function Overhead({ reduced }: { reduced: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: reduced ? 0 : 6 }}
      animate={reduced ? { opacity: 1, y: 0 } : { opacity: 1, y: [0, -6, 0] }}
      exit={{ opacity: 0 }}
      transition={
        reduced
          ? { duration: 0 }
          : { y: { duration: 1.4, repeat: Infinity, ease: "easeInOut" }, opacity: { duration: 0.2 } }
      }
      data-testid="overhead"
      className="absolute left-1/2 top-[max(5.6rem,calc(env(safe-area-inset-top)+5.2rem))] flex -translate-x-1/2 flex-col items-center gap-1"
    >
      <svg width="26" height="14" viewBox="0 0 26 14" fill="none" aria-hidden>
        <path
          d="M2 12 L13 2 L24 12"
          stroke="var(--hunt)"
          strokeWidth="2.5"
          strokeLinecap="square"
        />
      </svg>
      <span className="label-type text-hunt">Above you</span>
    </motion.div>
  );
}

/** Four ticks and a dot. It goes accent when a drone is inside the cone the server counts. */
function Crosshair({ hot, firedAt, reduced }: { hot: boolean; firedAt: number; reduced: boolean }) {
  const colour = hot ? "var(--hunt)" : "rgba(243,239,231,0.55)";
  const arm = "absolute bg-current";

  return (
    <motion.div
      animate={{ scale: hot && !reduced ? 1.25 : 1, opacity: hot ? 1 : 0.8 }}
      transition={{ duration: reduced ? 0 : 0.18, ease: "easeOut" }}
      className="relative h-6 w-6"
      style={{ color: colour }}
    >
      {firedAt > 0 && (
        <motion.span
          key={firedAt}
          aria-hidden
          data-testid="shot-kick"
          initial={{ opacity: reduced ? 0 : 1, scale: 0.35 }}
          animate={{ opacity: 0, scale: 2.1 }}
          transition={{ duration: reduced ? 0 : 0.2, ease: "easeOut" }}
          className="absolute inset-0 rounded-full border border-hunt"
        />
      )}
      <span className={`${arm} left-1/2 top-0 h-1.5 w-px -translate-x-1/2`} />
      <span className={`${arm} bottom-0 left-1/2 h-1.5 w-px -translate-x-1/2`} />
      <span className={`${arm} left-0 top-1/2 h-px w-1.5 -translate-y-1/2`} />
      <span className={`${arm} right-0 top-1/2 h-px w-1.5 -translate-y-1/2`} />
      <span className={`${arm} left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full`} />
    </motion.div>
  );
}
