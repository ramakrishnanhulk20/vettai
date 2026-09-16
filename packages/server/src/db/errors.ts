/**
 * True when the database refused a write because a unique index already holds that
 * value. Drizzle wraps the driver's error in its own, so the real Postgres code sits
 * one or two `cause` links down rather than on the error we catch.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error

  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true
    const message = String((current as { message?: unknown }).message ?? '')
    if (/duplicate key value|unique constraint/i.test(message)) return true
    current = (current as { cause?: unknown }).cause
  }

  return false
}

/**
 * Which unique index refused the write, so a caller can tell "this quest was already
 * claimed" from "that memo is taken". PGlite names the index in
 * `constraint` and postgres.js in `constraint_name`; the message is read as a last resort
 * because a driver that reports neither would otherwise look like an unknown failure.
 * Null when the error is not a unique violation or does not name an index.
 */
export function uniqueViolationIndex(error: unknown): string | null {
  let current: unknown = error

  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const named = current as { constraint?: unknown; constraint_name?: unknown; message?: unknown }
    if (typeof named.constraint === 'string' && named.constraint.length > 0) return named.constraint
    if (typeof named.constraint_name === 'string' && named.constraint_name.length > 0) {
      return named.constraint_name
    }

    const fromMessage = /unique constraint "([^"]+)"/i.exec(String(named.message ?? ''))
    if (fromMessage?.[1]) return fromMessage[1]

    current = (current as { cause?: unknown }).cause
  }

  return null
}
