import { authChallenge, authLogout, authVerify, getMe, type Me } from "./api";
import { sign } from "./nimiq";

/**
 * Signing in, Vango's proven way: the server hands out a nonce, the wallet signs it once,
 * and the server reads the address off the public key. The game never states its own
 * address, so a phone cannot ask for somebody else's quests.
 */

const KEY = "vettai.session";

export type Session = { token: string; address: string };

export function readSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, address } = parsed as Partial<Session>;
    if (typeof token !== "string" || typeof address !== "string") return null;
    return { token, address };
  } catch {
    return null;
  }
}

export function readToken(): string | null {
  return readSession()?.token ?? null;
}

function writeSession(session: Session): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

/**
 * One native dialog, and only when there is no token yet. A refusal from the wallet comes
 * back out as a throw so the caller can tell a cancel from a server problem; everything
 * else is reported as a sentence.
 */
export async function login(): Promise<Session> {
  const existing = readSession();
  if (existing) return existing;

  const challenge = await authChallenge();
  if (!challenge.ok) throw new Error(challenge.error);

  const signed = await sign(challenge.data.message);

  const verified = await authVerify({
    message: challenge.data.message,
    publicKey: signed.publicKey,
    signature: signed.signature,
  });
  if (!verified.ok) throw new Error(verified.error);

  const session = { token: verified.data.token, address: verified.data.address };
  writeSession(session);
  return session;
}

/** Who the server thinks this token belongs to, or null when the token is no longer good. */
export async function me(): Promise<Me | null> {
  const result = await getMe();
  if (result.ok) return result.data;
  if (result.status === 401) clearToken();
  return null;
}

export async function logout(): Promise<void> {
  await authLogout();
  clearToken();
}
