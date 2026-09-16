"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

export const EASE = [0.16, 1, 0.3, 1] as const;

type Props = {
  children: ReactNode;
  className?: string;
  delay?: number;
  /** How far the block rises into place. Big blocks travel further than small ones. */
  distance?: number;
  as?: "div" | "li" | "section" | "header" | "footer";
};

/**
 * One reveal for the whole page, so every section enters with the hero's timing.
 * The starting position is the same on the server and on the client whatever the
 * motion setting is, because a different one on each side fails hydration. With
 * motion turned down the block simply snaps into place instead of travelling.
 */
export default function Reveal({
  children,
  className,
  delay = 0,
  distance = 28,
  as = "div",
}: Props) {
  const reduced = useReducedMotion();
  const Tag = motion[as];

  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={reduced ? { duration: 0 } : { duration: 0.85, delay, ease: EASE }}
    >
      {children}
    </Tag>
  );
}
