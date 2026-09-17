"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useDragControls, type PanInfo } from "framer-motion";
import styles from "./play.module.css";

/**
 * A panel that slides up over the street. The city keeps running behind it, dimmed, so a
 * player never loses the thing they are standing in.
 *
 * It is rendered into the body rather than into the game surface: the stage sets
 * `touch-action: none` to stop the page rubber-banding under a thumb, and a list inside
 * that cannot be scrolled by touch at all.
 *
 * Two ways out, and neither fights the list: the dimmed strip above the panel closes it on
 * a tap, and a drag down that starts on the handle or the header flicks it away. The drag
 * is never started by the list itself, so a thumb sliding down a row scrolls the row.
 */

export type SheetProps = {
  kicker: string;
  title: string;
  meta?: string;
  /** The word ghosted across the panel, the same mark the poster uses. */
  watermark?: string;
  reduced: boolean;
  onClose: () => void;
  children: ReactNode;
};

const EASE = [0.16, 1, 0.3, 1] as const;

/** A flick this far down, or this fast, means the player wants the street back. */
const DRAG_CLOSE_PX = 120;
const DRAG_CLOSE_VELOCITY = 620;

export default function Sheet({
  kicker,
  title,
  meta,
  watermark,
  reduced,
  onClose,
  children,
}: SheetProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  /** How tall the panel is right now, so the dimmed area above it ends where it begins. */
  const [panelHeight, setPanelHeight] = useState(0);
  const drag = useDragControls();

  useEffect(() => setHost(document.body), []);

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const measure = () => setPanelHeight(node.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, [host]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!host) return null;

  const settle = (_event: unknown, info: PanInfo) => {
    if (info.offset.y > DRAG_CLOSE_PX || info.velocity.y > DRAG_CLOSE_VELOCITY) onClose();
  };

  const startDrag = (event: PointerEvent) => {
    if (!reduced) drag.start(event);
  };

  return createPortal(
    <div className="fixed inset-0 z-50">
      <motion.button
        type="button"
        aria-label="Close"
        onClick={onClose}
        data-testid="sheet-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.3 }}
        style={{ ["--sheet-h"]: `${panelHeight}px` } as CSSProperties}
        className="absolute inset-x-0 top-0 bottom-[var(--sheet-h)] w-full cursor-default bg-night/72 backdrop-blur-[3px] sm:bottom-0"
      />

      {/* Portrait gets a sheet rising off the bottom edge; anything wider gets the same
          panel as a card standing off the left, so the street stays in the frame. */}
      <motion.section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ y: reduced ? 0 : "100%", opacity: reduced ? 0 : 1 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: reduced ? 0 : "100%", opacity: reduced ? 0 : 1 }}
        transition={reduced ? { duration: 0 } : { duration: 0.52, ease: EASE }}
        drag={reduced ? false : "y"}
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.4 }}
        onDragEnd={settle}
        className={`${styles.sheet} absolute inset-x-0 bottom-0 flex max-h-[86svh] flex-col overflow-hidden border-t border-hunt/55 bg-night sm:inset-x-auto sm:bottom-10 sm:left-12 sm:max-h-[80svh] sm:w-[min(34rem,calc(100vw-6rem))] sm:border-x sm:border-line`}
      >
        <div aria-hidden className={styles.sheetGrain} />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-40"
          style={{
            background:
              "radial-gradient(120% 100% at 12% 0%, rgba(255,106,43,0.16) 0%, rgba(255,106,43,0) 62%)",
          }}
        />
        {watermark && (
          <span
            aria-hidden
            data-testid="sheet-watermark"
            className="display-type pointer-events-none absolute right-2 top-5 select-none text-[clamp(3rem,15vw,5.5rem)] uppercase leading-none tracking-[-0.04em] text-paper/[0.045]"
          >
            {watermark}
          </span>
        )}

        <div
          data-testid="sheet-handle"
          onPointerDown={startDrag}
          className="relative flex justify-center py-2.5"
          style={{ touchAction: "none" }}
        >
          <span aria-hidden className="h-1 w-12 rounded-full bg-paper/25" />
        </div>

        <header
          onPointerDown={startDrag}
          className="relative px-6 pb-4 pt-1"
          style={{ touchAction: "none" }}
        >
          <div className="flex items-start justify-between gap-4">
            <p className="label-type text-hunt">{kicker}</p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 -mt-2 flex h-11 w-11 items-center justify-center rounded-btn border border-line text-paper/55 transition-colors duration-200 hover:border-hunt hover:text-paper active:border-hunt"
            >
              <svg viewBox="0 0 14 14" className="h-4 w-4" aria-hidden>
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" fill="none" />
              </svg>
            </button>
          </div>

          <h2 className="display-type mt-2 text-[clamp(1.9rem,8.5vw,2.9rem)] uppercase leading-[0.92] tracking-[-0.02em]">
            {title}
          </h2>
          {meta && <p className="label-type mt-2 text-paper/40">{meta}</p>}
        </header>

        <div
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-[max(1.75rem,env(safe-area-inset-bottom))]"
          style={{ touchAction: "pan-y" }}
        >
          {children}
        </div>
      </motion.section>
    </div>,
    host,
  );
}

/** A row that enters with the ones above it, so a list arrives as a list and not at once. */
export function SheetRow({
  index,
  reduced,
  children,
}: {
  index: number;
  reduced: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: reduced ? 0 : 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduced ? { duration: 0 } : { duration: 0.5, ease: EASE, delay: 0.06 + index * 0.05 }
      }
    >
      {children}
    </motion.div>
  );
}
