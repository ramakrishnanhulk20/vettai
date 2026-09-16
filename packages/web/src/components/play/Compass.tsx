"use client";

import { motion } from "framer-motion";
import styles from "./play.module.css";

/**
 * The strip across the top of the city: where the objective is relative to the way the
 * camera is facing, where the two doors are, and where the live drones are.
 *
 * Not one of these ticks is React's business. The render loop writes a pixel offset per
 * tick into a CSS variable every frame and the transforms below read it, so a player can
 * swing the camera around without the HUD rendering once.
 */

/** How many drone ticks the strip has room for. The nearest ones win. */
export const DRONE_TICKS = 6;

export default function Compass({ reduced }: { reduced: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: reduced ? 0 : -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.5, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.2 }}
      data-testid="compass"
      aria-hidden
      className={`pointer-events-none absolute left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] h-7 w-[200px] -translate-x-1/2 ${styles.compass}`}
    >
      <span className={styles.compassRule} />
      <span className={styles.compassAhead} />

      {Array.from({ length: DRONE_TICKS }, (_, index) => (
        <span
          key={index}
          data-testid={`compass-drone-${index}`}
          className={styles.compassDrone}
          style={{
            transform: `translate3d(calc(-50% + var(--cmp-d${index}-x, 0px)), 0, 0)`,
            opacity: `var(--cmp-d${index}-on, 0)`,
          }}
        />
      ))}

      <span
        data-testid="compass-office"
        className={styles.compassPlace}
        style={{
          transform: "translate3d(calc(-50% + var(--cmp-o-x, 0px)), 0, 0)",
          opacity: "var(--cmp-o-on, 0)",
        }}
      >
        O
      </span>
      <span
        data-testid="compass-shop"
        className={styles.compassPlace}
        style={{
          transform: "translate3d(calc(-50% + var(--cmp-s-x, 0px)), 0, 0)",
          opacity: "var(--cmp-s-on, 0)",
          color: "var(--ok)",
        }}
      >
        S
      </span>

      <span
        data-testid="compass-target"
        className={styles.compassTarget}
        style={{
          transform: "translate3d(calc(-50% + var(--cmp-t-x, 0px)), 0, 0)",
          opacity: "var(--cmp-t-on, 0)",
        }}
      >
        <span className={styles.compassBlade} />
        <span data-testid="compass-range" className={styles.compassRange} />
      </span>

      <span className={`${styles.compassEdge} ${styles.compassEdgeLeft}`}>&#9664;</span>
      <span className={`${styles.compassEdge} ${styles.compassEdgeRight}`}>&#9654;</span>
    </motion.div>
  );
}
