/**
 * What the landing page is allowed to read. Both shapes are copied from the server
 * routes (packages/server/src/routes/stats.ts and ladder.ts) and nothing on the page
 * exists outside them, so every number a judge sees was counted by the server.
 */

export type DailyTotals = {
  day: string;
  players: number;
  kills: number;
  paidLuna: string;
};

export type Stats = {
  day: string;
  playersToday: number;
  playersAllTime: number;
  killsToday: number;
  paidLuna: string;
  paidNim: string;
  claimsPaid: number;
  history: DailyTotals[];
};

export type LadderEntry = {
  place: number;
  address: string;
  kills: number;
};

export type Ladder = {
  week: string;
  prizesNim: string[];
  entries: LadderEntry[];
};

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

// Three sections want the same totals. One request is shared between them rather than
// each component asking the server the same question on the same scroll.
let statsOnce: Promise<Stats> | null = null;

export function getStats(): Promise<Stats> {
  if (!statsOnce) {
    statsOnce = read<Stats>("/api/stats").catch((error: unknown) => {
      statsOnce = null;
      throw error;
    });
  }
  return statsOnce;
}

export function getLadder(signal?: AbortSignal): Promise<Ladder> {
  return read<Ladder>("/api/ladder/week", signal);
}

export function whole(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function nim(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount);
}
