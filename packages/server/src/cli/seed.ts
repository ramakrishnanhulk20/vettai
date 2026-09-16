import { runCrowd } from './bot.js'

/**
 * Fills a local world with something to look at.
 *
 * Three scripted wallets sign in and play for a minute and a half against a server that is
 * already running, so every player, kill, quest and ladder row a judge sees was produced by
 * the same simulation a phone drives. Nothing here writes a row by hand, which is the whole
 * reason this is a bot rather than a list of inserts.
 */

const PLAYERS = 3
const SECONDS = 90
const DEFAULT_URL = 'http://localhost:8788'

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`)
}

const url = process.env['VETTAI_URL'] ?? DEFAULT_URL

log(`seeding ${url} with ${PLAYERS} players for ${SECONDS}s, start the world first with npm run dev`)

await runCrowd({ players: PLAYERS, seconds: SECONDS, url }, log)

log('seeded')
process.exit(0)
