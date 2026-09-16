"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getClaims, type ClaimView } from "@/lib/api";

/**
 * Every payout this wallet has asked for, kept current while any of them is still moving.
 *
 * The treasury sends on its own clock, so the only way the phone learns that money landed
 * is to ask. The poll runs while something is in flight and stops when nothing is, which
 * is what keeps a parked game off the server.
 */

const POLL_MS = 3000;

const MOVING = new Set<ClaimView["state"]>(["queued", "sending", "sent"]);

export type ClaimsFeed = {
  claims: ClaimView[];
  /** The newest claim per quest, which is the one a board row is about. */
  byQuest: Map<string, ClaimView>;
  inFlight: number;
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

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || inFlight === 0) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, inFlight, refresh]);

  return { claims, byQuest: newestByQuest(claims), inFlight, loaded, refresh };
}
