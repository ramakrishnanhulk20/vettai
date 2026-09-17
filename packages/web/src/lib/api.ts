import type { WorldMap } from "@/game/map";
import { clearToken, readToken } from "./session";

/**
 * Every call the game makes to the world server.
 *
 * Nothing here throws. A call answers `{ ok: true, data }` or `{ ok: false, status, error }`
 * with a sentence a player can act on, because a game loop that has to catch exceptions
 * around a HUD refresh ends up dropping frames or swallowing the reason.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; code?: string };

export type Gear = { blaster: "mk1" | "mk2"; skin: string; sprint?: boolean };

export type QuestKind = "hunt" | "courier" | "landmarks" | "landlord" | "streak";

export type QuestView = {
  id: string;
  kind: QuestKind;
  day: string;
  target: number;
  progress: number;
  state: "open" | "done" | "claimed";
  rewardLuna: string;
  rewardNim: string;
  route?: { from: number; to: number };
  visited?: boolean[];
  carrying?: boolean;
  /**
   * Which day of the run this streak is, counted by the server from its own quest rows.
   * Absent on a world that does not send it, and the board then counts claim rows instead.
   */
  streakDay?: number;
};

export type Challenge = { message: string; nonce: string; expiresAt: number };

export type LoginResult = { token: string; address: string };

export type Me = {
  address: string;
  gear: Gear;
  landlordSince: string | null;
  createdAt: string;
};

export type Ticket = { ticket: string; expiresInMs: number };

export type ClaimView = {
  id: string;
  questId: string | null;
  kind: string;
  state: "queued" | "sending" | "sent" | "paid" | "failed" | "held";
  amountLuna: string;
  amountNim: string;
  memo: string;
  txHash: string | null;
  blockNumber: number | null;
  createdAt: string;
  paidAt: string | null;
  error: string | null;
};

export type ShopItem = {
  id: string;
  name: string;
  priceLuna: string;
  priceNim: string;
  gear: Partial<Gear>;
};

export type ShopView = { to: string; items: ShopItem[] };

export type ShopOrder = {
  orderId: string;
  item: string;
  to: string;
  luna: string;
  nim: string;
  memo: string;
  expiresAt: string;
};

export type ClaimResponse = {
  state: "queued" | "held";
  claimId: string;
  memo: string;
  amountLuna: string;
  amountNim: string;
  /** Only on a hold, and it is a delay rather than a refusal. */
  reason?: "daily cap" | "ip cap" | "pool";
};

export type ShopOrderState = {
  orderId: string;
  item: string;
  state: "pending" | "paid" | "expired";
  luna: string;
  nim: string;
  memo: string;
  to: string;
  txHash: string | null;
  expiresAt: string;
};

export type Health = {
  ok: boolean;
  network: "TestAlbatross" | "MainAlbatross";
  rooms: number;
  online: number;
  /** What one wallet may be paid in a day, in NIM. Absent on a world that does not say. */
  dailyCapNim?: string;
};

export type LadderWeek = {
  week: string;
  prizesNim: string[];
  entries: { place: number; address: string; kills: number }[];
};

export type Stats = {
  day: string;
  playersToday: number;
  playersAllTime: number;
  killsToday: number;
  paidLuna: string;
  paidNim: string;
  claimsPaid: number;
  history: { day: string; players: number; kills: number; paidLuna: string }[];
};

type Options = { method?: "GET" | "POST"; body?: unknown; auth?: boolean };

const OFFLINE = "The world server did not answer. Check your connection and try again.";

function messageOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

function codeOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** What the world says when the token itself is no longer good. */
const SESSION_GONE = "not signed in";

/**
 * Whether a refusal is about the session or about the thing being asked for. Only the
 * first kind may throw the sign in away: a claim the world will not pay is not a reason to
 * make the player sign in again, and treating it as one used to cost them their session
 * every time a signature arrived a second late.
 */
function sessionIsGone(status: number, message: string | null, code: string | null): boolean {
  if (code === "session") return true;
  if (status !== 401) return false;
  return message !== null && message.toLowerCase().includes(SESSION_GONE);
}

/**
 * In the browser every call is same-origin and the Next rewrite forwards it, so the Pay
 * WebView has one hostname to trust for the API, the socket and the page.
 */
async function request<T>(path: string, options: Options = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  if (options.auth) {
    const token = readToken();
    if (!token) return { ok: false, status: 401, error: "This wallet is not signed in yet." };
    headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      cache: "no-store",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    return { ok: false, status: 0, error: OFFLINE };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message = messageOf(payload);
    const code = codeOf(payload);
    if (options.auth && sessionIsGone(response.status, message, code)) clearToken();
    return {
      ok: false,
      status: response.status,
      error: message ?? "The world server refused that. Try again.",
      ...(code === null ? {} : { code }),
    };
  }

  return { ok: true, data: payload as T };
}

export function authChallenge(): Promise<ApiResult<Challenge>> {
  return request("/api/auth/challenge", { method: "POST", body: {} });
}

export function authVerify(body: {
  message: string;
  publicKey: string;
  signature: string;
}): Promise<ApiResult<LoginResult>> {
  return request("/api/auth/verify", { method: "POST", body });
}

export function authLogout(): Promise<ApiResult<{ ok: boolean }>> {
  return request("/api/auth/logout", { method: "POST", body: {}, auth: true });
}

export function getMe(): Promise<ApiResult<Me>> {
  return request("/api/me", { auth: true });
}

export function getWorldMap(): Promise<ApiResult<WorldMap>> {
  return request("/api/world/map");
}

export function getTicket(): Promise<ApiResult<Ticket>> {
  return request("/api/world/ticket", { auth: true });
}

export function getQuestsToday(): Promise<ApiResult<{ day: string; quests: QuestView[] }>> {
  return request("/api/quests/today", { auth: true });
}

export function getClaims(): Promise<ApiResult<{ claims: ClaimView[] }>> {
  return request("/api/claims", { auth: true });
}

export function getShop(): Promise<ApiResult<ShopView>> {
  return request("/api/shop");
}

export function createShopOrder(item: string): Promise<ApiResult<ShopOrder>> {
  return request("/api/shop/orders", { method: "POST", body: { item }, auth: true });
}

export function getLadderWeek(): Promise<ApiResult<LadderWeek>> {
  return request("/api/ladder/week");
}

export function getStats(): Promise<ApiResult<Stats>> {
  return request("/api/stats");
}

export function claimChallenge(questId: string): Promise<ApiResult<Challenge>> {
  return request(`/api/quests/${questId}/claim/challenge`, { method: "POST", body: {}, auth: true });
}

export function submitClaim(
  questId: string,
  body: { message: string; publicKey: string; signature: string },
): Promise<ApiResult<ClaimResponse>> {
  return request(`/api/quests/${questId}/claim`, { method: "POST", body, auth: true });
}

export function getShopOrder(orderId: string): Promise<ApiResult<ShopOrderState>> {
  return request(`/api/shop/orders/${orderId}`, { auth: true });
}

/**
 * Which chain the world server is paying on, which decides the explorer a payout links to.
 * The world serves this outside /api, so in a split deployment the call can be refused;
 * a payout then shows its hash as text rather than pointing at the wrong explorer.
 */
export function getHealth(): Promise<ApiResult<Health>> {
  return request("/health");
}
