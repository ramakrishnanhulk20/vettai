import { createHash, randomBytes } from 'node:crypto'

/**
 * A session token carries a prefix so it can never be mistaken for a row id, and so a
 * leaked string is recognisable in a log or a bug report. The database stores only the
 * sha256, which means a stolen table dump cannot be replayed as a login.
 */
export const SESSION_PREFIX = 'vt1.'

const SESSION_BYTES = 32

const SESSION_PATTERN = new RegExp(`^${SESSION_PREFIX.replace('.', '\.')}[0-9a-f]{${SESSION_BYTES * 2}}$`)

export function issueSessionToken(): string {
  return `${SESSION_PREFIX}${randomBytes(SESSION_BYTES).toString('hex')}`
}

/** The token when it is one of ours by shape, null otherwise. Nothing here proves it exists. */
export function parseSessionToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return SESSION_PATTERN.test(trimmed) ? trimmed : null
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Pulls the token out of an `Authorization: Bearer ...` header, or null if there is none. */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}
