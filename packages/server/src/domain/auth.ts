import { and, eq, gt, lt } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { players, sessions, type Player } from '../db/schema.js'
import { hashToken, issueSessionToken, parseSessionToken } from '../lib/tokens.js'
import { verifySignedMessage } from '../nimiq/verify.js'
import { consumeChallenge, parseChallengeMessage } from './challenges.js'

/** A phone stays signed in for a month, then signs one more message. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type LoginInput = {
  message: string
  publicKey: string
  signature: string
  ipHash?: string | undefined
}

export type LoginResult =
  | { ok: true; token: string; address: string }
  | { ok: false; status: number; error: string }

/**
 * Turns a signed challenge into a signed-in player.
 *
 * The address is read off the public key, never taken from the request, so a client
 * cannot name a wallet it does not hold. The nonce inside the message proves the
 * signature was made for this login and not copied from an older one. The signature is
 * checked before the nonce is spent, so a bad signature cannot burn somebody else's
 * challenge.
 */
export async function login(db: Db, input: LoginInput): Promise<LoginResult> {
  const parsed = parseChallengeMessage(input.message)
  if (!parsed || parsed.kind !== 'login') {
    return { ok: false, status: 400, error: 'message is not a vettai login challenge' }
  }

  const verified = verifySignedMessage({
    message: input.message,
    publicKeyHex: input.publicKey,
    signatureHex: input.signature,
  })
  if (!verified.ok) return { ok: false, status: 401, error: verified.reason }

  const claimed = await consumeChallenge(db, input.message)
  if (!claimed.ok) return { ok: false, status: 401, error: claimed.reason }

  const address = verified.address
  const now = new Date()

  await db
    .insert(players)
    .values({
      address,
      publicKey: input.publicKey.trim().toLowerCase(),
      lastSeenAt: now,
      lastIpHash: input.ipHash ?? null,
    })
    .onConflictDoUpdate({
      target: players.address,
      set: {
        publicKey: input.publicKey.trim().toLowerCase(),
        lastSeenAt: now,
        lastIpHash: input.ipHash ?? null,
      },
    })

  const token = await createSession(db, address, now)

  return { ok: true, token, address }
}

/** Mints a session token. The plain token is returned once here and never stored. */
export async function createSession(db: Db, address: string, now: Date = new Date()): Promise<string> {
  const token = issueSessionToken()

  await db.delete(sessions).where(lt(sessions.expiresAt, now))
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    address,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  })

  return token
}

/** The player behind a token, or null when the token is unknown or past its month. */
export async function resolveSession(db: Db, token: string): Promise<Player | null> {
  const parsedToken = parseSessionToken(token)
  if (!parsedToken) return null

  const [row] = await db
    .select({ player: players })
    .from(sessions)
    .innerJoin(players, eq(players.address, sessions.address))
    .where(and(eq(sessions.tokenHash, hashToken(parsedToken)), gt(sessions.expiresAt, new Date())))
    .limit(1)

  return row?.player ?? null
}

/** Drops a session. True when there was one to drop, which is all a caller needs to know. */
export async function logout(db: Db, token: string): Promise<boolean> {
  const parsedToken = parseSessionToken(token)
  if (!parsedToken) return false

  const gone = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, hashToken(parsedToken)))
    .returning({ tokenHash: sessions.tokenHash })

  return gone.length > 0
}
