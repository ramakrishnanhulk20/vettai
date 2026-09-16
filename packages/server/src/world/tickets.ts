import { randomBytes } from 'node:crypto'

/**
 * A one-minute, one-shot pass to the socket.
 *
 * A browser cannot put an Authorization header on a WebSocket handshake, so the session
 * token would otherwise have to travel in the query string, where it lands in every proxy
 * log and in the phone's history. A ticket is issued to a signed-in caller over the normal
 * API, spent once on the upgrade, and useless a minute later, so a log that keeps it holds
 * nothing worth stealing.
 *
 * Tickets live in memory on purpose: they are worth less than the session they came from
 * and they are gone within a minute, so a restart losing them costs a player one click.
 */

export const TICKET_TTL_MS = 60_000

const TICKET_PREFIX = 'vtk1.'

const TICKET_BYTES = 24

const TICKET_PATTERN = new RegExp(`^vtk1\\.[0-9a-f]{${TICKET_BYTES * 2}}$`)

type Issued = { address: string; expiresAt: number }

const live = new Map<string, Issued>()

function sweep(now: number): void {
  for (const [ticket, issued] of live) {
    if (issued.expiresAt <= now) live.delete(ticket)
  }
}

/** Hands out a pass for one wallet. The caller has already proven it holds that wallet. */
export function issueTicket(address: string, now: number = Date.now()): string {
  sweep(now)

  const ticket = `${TICKET_PREFIX}${randomBytes(TICKET_BYTES).toString('hex')}`
  live.set(ticket, { address, expiresAt: now + TICKET_TTL_MS })
  return ticket
}

/**
 * Spends a pass and answers with the wallet behind it, or null when the string is not a
 * ticket, is past its minute, or has already been spent. The entry is dropped before the
 * answer is built, so two upgrades racing on one ticket can never both be let in.
 */
export function redeemTicket(ticket: unknown, now: number = Date.now()): string | null {
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) return null

  const issued = live.get(ticket)
  if (!issued) return null
  live.delete(ticket)

  return issued.expiresAt > now ? issued.address : null
}
