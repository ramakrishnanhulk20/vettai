import type { ClaimView } from "@/lib/api";

/**
 * The small conversions the panels share. Every amount arrives from the server in luna
 * and is turned into NIM here, in one place, so no two screens can round a payout
 * differently.
 */

const LUNA = 100_000;

/** 50000 becomes "0.5". Five decimals is the whole of a luna, and trailing zeros go. */
export function nim(luna: string | number): string {
  const value = Number(luna) / LUNA;
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
}

export type Network = "TestAlbatross" | "MainAlbatross";

/** Where a transaction can be read by anyone. Null while the network is still unknown. */
export function explorer(network: Network | null, txHash: string): string | null {
  if (!network) return null;
  const host = network === "TestAlbatross" ? "test.nimiq.watch" : "nimiq.watch";
  return `https://${host}/#${txHash}`;
}

export function shortHash(txHash: string): string {
  return `${txHash.slice(0, 10)}...${txHash.slice(-6)}`;
}

/**
 * Which day of the streak today is, counted the same way the server counts it: the run of
 * UTC days directly before today on which this wallet actually claimed its streak, plus
 * today. A claim row exists exactly when a streak quest was claimed, so the claims list is
 * the same evidence the server reads and nothing here is guessed.
 */
export function streakDay(claims: ClaimView[], todayUtc: string): number {
  const claimed = new Set(
    claims.filter((claim) => claim.kind === "streak").map((claim) => claim.createdAt.slice(0, 10)),
  );

  let day = new Date(`${todayUtc}T00:00:00Z`).getTime();
  let run = 0;
  for (;;) {
    day -= 86_400_000;
    const stamp = new Date(day).toISOString().slice(0, 10);
    if (!claimed.has(stamp)) break;
    run += 1;
    if (run > 400) break;
  }
  return run + 1;
}

/** The moment an ISO week like 2026-W38 runs out, as a date in the reader's own time. */
export function weekEnds(week: string): Date | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match?.[1] || !match[2]) return null;

  const mondayIndex = (date: Date) => (date.getUTCDay() + 6) % 7;
  const firstMonday = new Date(Date.UTC(Number(match[1]), 0, 4));
  firstMonday.setUTCDate(firstMonday.getUTCDate() - mondayIndex(firstMonday));

  const start = firstMonday.getTime() + (Number(match[2]) - 1) * 7 * 86_400_000;
  return new Date(start + 7 * 86_400_000);
}

export function localMoment(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function utcDate(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
