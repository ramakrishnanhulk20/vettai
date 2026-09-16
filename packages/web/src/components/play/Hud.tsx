"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { QuestView } from "@/lib/api";
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

export type HudProps = {
  shield: number;
  quests: QuestView[];
  toasts: Toast[];
  latency: number | null;
  aimHot: boolean;
  /** The moment of the last shot this phone drew, which kicks the crosshair. */
  firedAt: number;
  prompt: { text: string } | null;
  onInteract: () => void;
  /** The quest strip and the Board button both lead to the same place. */
  onOpenBoard: () => void;
  nearOffice: boolean;
  /** Claims the treasury has not finished sending yet. */
  payouts: number;
  /** The moment the last payout landed, which flashes the shield bars. */
  paidAt: number;
  attachFire: (button: HTMLElement | null) => void;
  /** The moment the last shield bar was lost, which flashes the edge of the screen. */
  hitAt: number;
  showHint: boolean;
  /** While a panel is up the thumb belongs to the panel, so the controls step back. */
  sheetOpen: boolean;
  reduced: boolean;
};

const MAX_SHIELD = 3;

function questTitle(kind: QuestView["kind"]): string {
  if (kind === "hunt") return "Hunt";
  if (kind === "courier") return "Courier";
  if (kind === "landmarks") return "Landmarks";
  if (kind === "landlord") return "Landlord";
  return "Streak";
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
  toasts,
  latency,
  aimHot,
  firedAt,
  prompt,
  onInteract,
  onOpenBoard,
  nearOffice,
  payouts,
  paidAt,
  attachFire,
  hitAt,
  showHint,
  sheetOpen,
  reduced,
}: HudProps) {
  const claimable = quests.some((quest) => quest.state === "done");

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

      <div className="absolute left-4 top-[max(1rem,env(safe-area-inset-top))] flex flex-col gap-2">
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
        <span className="label-type text-paper/45">Shield</span>
      </div>

      <button
        type="button"
        onClick={onOpenBoard}
        data-testid="hud-quests"
        aria-label="Open the day's jobs"
        className={`pointer-events-auto absolute right-4 top-[max(1rem,env(safe-area-inset-top))] flex w-40 flex-col items-end gap-1.5 text-right transition-opacity duration-300 ${
          sheetOpen ? "opacity-30" : "opacity-100"
        }`}
      >
        <span className={`label-type ${claimable ? "text-hunt" : "text-paper/45"}`}>
          {claimable ? "Today, claim" : "Today"}
        </span>
        {quests.map((quest) => (
          <motion.span
            key={quest.id}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: reduced ? 0 : 0.4, ease: "easeOut" }}
            className="flex w-full items-baseline justify-end gap-2"
          >
            <span
              className={`label-type ${quest.state === "open" ? "text-paper/55" : "text-hunt"}`}
            >
              {questTitle(quest.kind)}
            </span>
            <span className="font-mono text-xs text-paper/80">
              {quest.state === "open" ? questCount(quest) : "done"}
            </span>
            {quest.state !== "open" && (
              <span aria-hidden className="text-xs leading-none text-hunt">
                &#10003;
              </span>
            )}
          </motion.span>
        ))}
        {payouts > 0 && (
          <span className="mt-1 font-mono text-[11px] text-hunt" data-testid="payouts-line">
            {payouts === 1 ? "1 payout on its way" : `${payouts} payouts on their way`}
          </span>
        )}
        {latency !== null && (
          <span className="mt-1 font-mono text-[10px] text-paper/30">{latency} ms</span>
        )}
        {latency !== null && latency > 250 && (
          <span className="font-mono text-[10px] text-paper/30" data-testid="far-note">
            far from the server
          </span>
        )}
      </button>

      <div className="pointer-events-none absolute inset-x-0 top-[max(5.5rem,calc(env(safe-area-inset-top)+5rem))] flex flex-col items-center gap-2">
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
        {prompt && !sheetOpen && (
          <motion.div
            key={prompt.text}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
            className="absolute inset-x-0 bottom-[max(12rem,calc(env(safe-area-inset-bottom)+11rem))] flex justify-center gap-2"
          >
            <button
              type="button"
              onClick={onInteract}
              data-testid="interact"
              className="pointer-events-auto rounded-btn border border-hunt bg-night/80 px-4 py-2.5 text-sm text-paper backdrop-blur transition-colors duration-200 hover:bg-hunt hover:text-night active:bg-hunt active:text-night"
            >
              {prompt.text}
            </button>
            {nearOffice && (
              <button
                type="button"
                onClick={onOpenBoard}
                data-testid="board-button"
                className="label-type pointer-events-auto rounded-btn border border-line bg-night/80 px-3 py-2.5 text-paper/70 backdrop-blur transition-colors duration-200 hover:border-hunt hover:text-paper"
              >
                Board
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showHint && !sheetOpen && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.6, delay: reduced ? 0 : 0.8 }}
            className="label-type absolute bottom-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))] left-6 text-paper/40"
          >
            Drag here to walk
          </motion.span>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        ref={attachFire}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: sheetOpen ? 0 : 1, scale: sheetOpen ? 0.9 : 1 }}
        transition={{ duration: reduced ? 0 : 0.35, ease: "easeOut" }}
        whileTap={reduced ? undefined : { scale: 0.92 }}
        aria-label="Fire"
        aria-hidden={sheetOpen}
        data-testid="fire"
        className={`label-type absolute bottom-[max(2.5rem,calc(env(safe-area-inset-bottom)+1.5rem))] right-6 flex h-[72px] w-[72px] items-center justify-center rounded-full border-2 border-hunt bg-hunt/15 text-hunt backdrop-blur-sm transition-colors duration-200 hover:bg-hunt/30 ${
          sheetOpen ? "pointer-events-none" : "pointer-events-auto"
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
