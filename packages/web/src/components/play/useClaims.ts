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
 *
 * A read that fails does not end the feed. The one thing a player cannot be left with is a
 * board that quietly stopped asking about their money, so a failure backs off and keeps
 * asking, and says out loud that the last answer did not arrive.
 */

const POLL_MS = 3000;
const HELD_POLL_MS = 60_000;

/** 3 s, 6 s, 12 s, then every 30. Long enough to let a server come back, short enough to notice. */
const RETRY_MS = [3000, 6000, 12_000];
const RETRY_CAP_MS = 30_000;

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
  /** What went wrong with the last read, or null when the last one came back. */
  error: string | null;
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

function retryWait(failures: number): number {
  return RETRY_MS[failures - 1] ?? RETRY_CAP_MS;
}

export function useClaims(
  enabled: boolean,
  onPaid: (claim: ClaimView) => void,
  /** The session is gone. The caller owns the one signature that puts it back. */
  onSignedOut: () => void,
): ClaimsFeed {
  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Reads that failed in a row. It is state, not a ref, because it drives the next wait. */
  const [failures, setFailures] = useState(0);

  const seen = useRef(new Map<string, ClaimView["state"]>());
  const known = useRef(false);
  const paid = useRef(onPaid);
  paid.current = onPaid;
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  const refresh = useCallback(async () => {
    const result = await getClaims();
    if (!result.ok) {
      setError(result.error);
      setFailures((count) => count + 1);
      // The token is already gone by the time a session refusal gets here, so the only
      // thing left is to ask for the signature that brings it back.
      if (result.status === 401) signedOut.current();
      return;
    }

    // The first read is the starting picture, not news: a payout from this morning must
    // not announce itself the moment the game opens. Only a read that came back counts as
    // that picture, or a failed first read would make the next one announce everything.
    for (const claim of result.data.claims) {
      const before = seen.current.get(claim.id);
      seen.current.set(claim.id, claim.state);
      if (!known.current || before === claim.state) continue;
      if (claim.state === "paid") paid.current(claim);
    }
    known.current = true;

    setClaims(result.data.claims);
    setLoaded(true);
    setError(null);
    setFailures(0);
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
    if (failures === 0 && inFlight === 0 && held === 0) return;
    const wait = failures > 0 ? retryWait(failures) : inFlight > 0 ? POLL_MS : HELD_POLL_MS;
    const timer = setTimeout(() => void refresh(), wait);
    return () => clearTimeout(timer);
  }, [enabled, failures, held, inFlight, refresh]);

  return {
    claims,
    byQuest: newestByQuest(claims),
    inFlight,
    held,
    heldOnPool,
    loaded,
    error,
    refresh,
  };
}
