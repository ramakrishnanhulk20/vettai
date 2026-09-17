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

/** A Nimiq address in the four character groups the wallet's own screens use. */
export function groupAddress(address: string): string {
  const stripped = address.replace(/\s+/g, "").toUpperCase();
  return (stripped.match(/.{1,4}/g) ?? [stripped]).join(" ");
}

/**
 * An address cut the way the ladder route cuts it before it sends a row, which is the only
 * way a screen can tell whether one of those rows is this wallet's own.
 */
export function shortAddress(address: string): string {
  const stripped = address.replace(/\s+/g, "").toUpperCase();
  return `${stripped.slice(0, 8)}...${stripped.slice(-4)}`;
}

/** What every refusal the world can send says, keyed by the code it sends with it. */
const REFUSALS: Record<string, string> = {
  "too far": "Too far away. Walk closer.",
  "unknown place": "Nothing to do here.",
  malformed: "That did not go through, try again.",
  session: "Your sign in ran out. Sign once more and carry on.",
  not_claimable: "That job is not finished yet. The board has been brought up to date.",
  bad_signature: "The wallet's signature did not check out. Nothing was sent, claim it again.",
  other_wallet: "That signature is from another wallet, not the one signed in. Nothing was sent.",
  nonce: "That claim sat too long and its code expired. Nothing was sent, claim it again.",
  // The treasury pays a limited number of wallets per connection per day, which a shared
  // office or a phone network trips long before anybody is gaming anything. The player is
  // in a queue, not under suspicion, and the sentence has to read that way.
  "ip cap":
    "More wallets on this network than we pay in one day. Yours is first in tomorrow's queue.",
};

/** The refusals the server sends as words with no code of their own. */
const BY_WORDS: Record<string, string> = {
  "no such quest": "That job is not on today's board any more.",
  "already claimed": "You have already claimed that one. The payout is on its way.",
  "that quest is not done yet": "That job is not finished yet.",
  "nothing to claim":
    "There is nothing to pay on that job today. The daily cap resets at midnight UTC.",
  "message is not a claim challenge for this quest":
    "That signature did not match the job. Claim it again.",
};

function sentence(words: string): string {
  const text = words.trim();
  if (text === "") return text;
  const capital = text[0]?.toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * One sentence for every refusal the world can hand back, so no screen ever prints a
 * server log line at a player.
 *
 * `detail` is the server's own words on the claim path, used when the code is one this
 * build has never heard of. On a socket refusal with nothing to do it is the job the
 * player is being pointed at instead, which is added to the end.
 */
export function refusalText(code?: string | null, detail?: string | null): string {
  const extra = detail?.trim() ?? "";

  if (code === "nothing to do") {
    return extra === "" ? "Nothing to do here yet." : `Nothing to do here yet. ${sentence(extra)}`;
  }

  const byCode = code ? REFUSALS[code] : undefined;
  if (byCode) return byCode;

  const byWords = BY_WORDS[extra.toLowerCase()];
  if (byWords) return byWords;

  return extra === "" ? "That did not go through, try again." : sentence(extra);
}

/**
 * Which day of the streak today is, worked out from the claims this phone can see: the run
 * of UTC days directly before today on which this wallet claimed its streak, plus today.
 *
 * This is the fallback. The server counts a day the daily cap cut to nothing as part of the
 * run even though it leaves no claim row, and the phone cannot see those days at all, so
 * when the world sends its own number on the streak quest that number wins.
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
