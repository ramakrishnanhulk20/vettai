import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { challenges } from '../db/schema.js'

/** Ten minutes is long enough for a slow wallet dialog and short enough to be useless later. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000

export type ChallengeKind = 'login' | 'claim' | 'shop'

export type IssuedChallenge = {
  nonce: string
  message: string
  expiresAt: number
}

export type ConsumeReason = 'malformed message' | 'nonce unknown' | 'nonce used' | 'nonce expired'

export type ConsumeResult =
  | { ok: true; kind: ChallengeKind; subject: string | null }
  | { ok: false; reason: ConsumeReason }

export type ParsedChallenge = {
  kind: ChallengeKind
  nonce: string
  subject: string | null
  expiresAt: number
}

const NONCE = '[0-9a-f]{32}'
const SUBJECT = '[0-9a-fA-F-]{36}'
const EXPIRY = '\\d{1,15}'

const LOGIN_MESSAGE = new RegExp(`^vettai-login:(${NONCE}):(${EXPIRY})$`)
const CLAIM_MESSAGE = new RegExp(`^vettai-claim:(${SUBJECT}):(${NONCE}):(${EXPIRY})$`)
const SHOP_MESSAGE = new RegExp(`^vettai-shop:(${SUBJECT}):(${NONCE}):(${EXPIRY})$`)

export function buildChallengeMessage(
  kind: ChallengeKind,
  subject: string | null,
  nonce: string,
  expiresAt: number,
): string {
  if (kind === 'login') return `vettai-login:${nonce}:${expiresAt}`
  if (subject === null) throw new Error(`a ${kind} challenge has to name what it is for`)
  return `vettai-${kind}:${subject}:${nonce}:${expiresAt}`
}

/** Reads a message back into its parts. Null when it is not one of ours at all. */
export function parseChallengeMessage(message: unknown): ParsedChallenge | null {
  if (typeof message !== 'string') return null

  const login = LOGIN_MESSAGE.exec(message)
  if (login?.[1] && login[2]) {
    return { kind: 'login', nonce: login[1], subject: null, expiresAt: Number(login[2]) }
  }

  const claim = CLAIM_MESSAGE.exec(message)
  if (claim?.[1] && claim[2] && claim[3]) {
    return { kind: 'claim', nonce: claim[2], subject: claim[1], expiresAt: Number(claim[3]) }
  }

  const shop = SHOP_MESSAGE.exec(message)
  if (shop?.[1] && shop[2] && shop[3]) {
    return { kind: 'shop', nonce: shop[2], subject: shop[1], expiresAt: Number(shop[3]) }
  }

  return null
}

/**
 * Hands out a one-shot challenge and writes it down before the phone ever sees it.
 *
 * The nonce lives in the database rather than in memory so a restart, the treasury and
 * a second world process can all spend the same challenge exactly once. Expired rows
 * are cleared on the way past; used rows are kept until they expire so a replay gets
 * told "nonce used" instead of the vaguer "nonce unknown".
 */
export async function issueChallenge(
  db: Db,
  kind: ChallengeKind,
  subject: string | null,
  now: Date = new Date(),
): Promise<IssuedChallenge> {
  if (kind !== 'login' && subject === null) {
    throw new Error(`a ${kind} challenge has to name what it is for`)
  }

  await db.delete(challenges).where(lt(challenges.expiresAt, now))

  const nonce = randomBytes(16).toString('hex')
  const expiry = new Date(now.getTime() + CHALLENGE_TTL_MS)

  await db.insert(challenges).values({ nonce, kind, subject, expiresAt: expiry })

  const expiresAt = expiry.getTime()
  return { nonce, message: buildChallengeMessage(kind, subject, nonce, expiresAt), expiresAt }
}

/**
 * Spends the challenge a signed message carries. The update is the lock: only one
 * caller can move used_at away from null, so two requests holding the same signature
 * can never both succeed. A nonce issued for another purpose or another quest reads as
 * unknown, because telling a caller which of the two it got wrong helps only an
 * attacker.
 */
export async function consumeChallenge(
  db: Db,
  message: string,
  now: Date = new Date(),
): Promise<ConsumeResult> {
  const parsed = parseChallengeMessage(message)
  if (!parsed) return { ok: false, reason: 'malformed message' }

  const matchesSubject =
    parsed.subject === null ? isNull(challenges.subject) : eq(challenges.subject, parsed.subject)

  const [claimed] = await db
    .update(challenges)
    .set({ usedAt: now })
    .where(
      and(
        eq(challenges.nonce, parsed.nonce),
        eq(challenges.kind, parsed.kind),
        matchesSubject,
        isNull(challenges.usedAt),
        gt(challenges.expiresAt, now),
      ),
    )
    .returning({ nonce: challenges.nonce })

  if (claimed) return { ok: true, kind: parsed.kind, subject: parsed.subject }

  const [row] = await db.select().from(challenges).where(eq(challenges.nonce, parsed.nonce)).limit(1)
  if (!row) return { ok: false, reason: 'nonce unknown' }
  if (row.usedAt !== null) return { ok: false, reason: 'nonce used' }
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'nonce expired' }
  return { ok: false, reason: 'nonce unknown' }
}
