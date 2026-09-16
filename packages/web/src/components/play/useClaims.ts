"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getClaims, type ClaimView } from "@/lib/api";

/**
 * Every payout this wallet has asked for, kept current while any of them is still moving.
 *
 * The treasury sends on its own clock, so the only way the phone learns that money landed
 * is to ask. Something in flight is a minute away at most, so it is asked after every few
 * seconds. A held payout waits for the next UTC midnight, so it is asked once a minute:
 * slow enough to cost nothing, often enough that a release shows up on its own rather
 * than on a reload. Nothing moving and nothing held means no poll at all.
 */

const POLL_MS = 3000;
const HELD_POLL_MS = 60_000;

const MOVING = new Set<ClaimView["state"]>(["queued", "sending", "sent"]);

export type ClaimsFeed = {
  claims: ClaimView[];
  /** The newest claim per quest, which is the one a board row is about. */
  byQuest: Map<string, ClaimView>;
  inFlight: number;
  /** Payouts the treasury is holding, which a player must be told about outside the board. */
  held: number;
  /** True when a hold is the pool running dry, which has no date on it. */
  heldOnPool: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
};

function newestByQuest(claims: ClaimView[]): Map<string, ClaimView> {
  const found = new Map<string, ClaimView>();
  for (const claim of claims) {
    if (!claim.questId) continue;
    const known = found.get(claim.questId);
    if (!known || known.createdAt < claim.createdAt) found.set(claim.questId, claim);
  }
  return found;
}

export function useClaims(enabled: boolean, onPaid: (claim: ClaimView) => void): ClaimsFeed {
  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const seen = useRef(new Map<string, ClaimView["state"]>());
  const known = useRef(false);
  const paid = useRef(onPaid);
  paid.current = onPaid;

  const refresh = useCallback(async () => {
    const result = await getClaims();
    if (!result.ok) return;

    // The first read is the starting picture, not news: a payout from this morning must
    // not announce itself the moment the game opens.
    for (const claim of result.data.claims) {
      const before = seen.current.get(claim.id);
      seen.current.set(claim.id, claim.state);
      if (!known.current || before === claim.state) continue;
      if (claim.state === "paid") paid.current(claim);
    }
    known.current = true;

    setClaims(result.data.claims);
    setLoaded(true);
  }, []);

  const inFlight = claims.filter((claim) => MOVING.has(claim.state)).length;
  const heldClaims = claims.filter((claim) => claim.state === "held");
  const held = heldClaims.length;
  const heldOnPool = heldClaims.some((claim) => claim.error === "pool");

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    if (inFlight === 0 && held === 0) return;
    const timer = setInterval(() => void refresh(), inFlight > 0 ? POLL_MS : HELD_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, held, inFlight, refresh]);

  return { claims, byQuest: newestByQuest(claims), inFlight, held, heldOnPool, loaded, refresh };
}
