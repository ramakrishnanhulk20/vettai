import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv, parse as parseEnv } from 'dotenv'
import { z } from 'zod'
import { nimToLuna } from './lib/luna.js'

const here = dirname(fileURLToPath(import.meta.url))
export const serverRoot = resolve(here, '..')

/** The key the treasury signs with lives in its own file, so the world cannot read it. */
export const treasuryEnvPath = resolve(serverRoot, '.env.treasury')

/**
 * True when this process is the one that holds the key and pays people. The host says so
 * with VETTAI_PROCESS; a person running `npm run treasury` by hand says nothing, so the
 * script that was started is read as well.
 */
export function isTreasuryProcess(
  env: Record<string, string | undefined>,
  entry: string = process.argv[1] ?? '',
): boolean {
  const named = (env['VETTAI_PROCESS'] ?? '').trim()
  if (named !== '') return /treasury/i.test(named)
  return /treasury[\\/]index\.(ts|js)$/i.test(entry)
}

loadEnv({ path: resolve(serverRoot, '.env'), quiet: true })

// Only the treasury reads the file with the key in it. The world is not given the chance
// to hold a key it must never have, even if somebody leaves the file on the same disk.
if (isTreasuryProcess(process.env)) {
  loadEnv({ path: treasuryEnvPath, override: true, quiet: true })
}

/** A key left blank in .env arrives as an empty string, which means "not set". */
const blankIsMissing = <T extends z.ZodType>(inner: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), inner)

/** An amount of NIM written the way a person writes it. Parsed to luna at the point of use. */
const nimAmount = () =>
  z.string().refine((value) => {
    try {
      return nimToLuna(value) >= 0n
    } catch {
      return false
    }
  }, 'must be an amount of NIM with at most 5 decimals')

const prizeList = () =>
  z
    .string()
    .refine((value) => value.split(',').length === 3, 'must be three amounts separated by commas')
    .refine((value) => {
      try {
        return value.split(',').every((part) => nimToLuna(part.trim()) >= 0n)
      } catch {
        return false
      }
    }, 'each prize must be an amount of NIM with at most 5 decimals')

const schema = z.object({
  PORT: blankIsMissing(z.coerce.number().int().min(1).max(65535).default(8788)),
  DATABASE_URL: blankIsMissing(z.string().min(1).optional()),
  NIMIQ_RPC_URL: z.url(),
  NIMIQ_NETWORK: z.enum(['TestAlbatross', 'MainAlbatross']),
  TREASURY_ADDRESS: z
    .string()
    .transform((value) => value.replace(/\s+/g, '').toUpperCase())
    .refine((value) => /^NQ[0-9A-Z]{34}$/.test(value), 'must be a Nimiq address'),
  TREASURY_PRIVATE_KEY: blankIsMissing(
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters').optional(),
  ),
  POOL_TOTAL_NIM: nimAmount(),
  DAILY_CAP_NIM: nimAmount(),
  IP_WALLETS_PER_DAY: blankIsMissing(z.coerce.number().int().min(1).max(100).default(2)),
  ALLOWED_ORIGINS: blankIsMissing(z.string().min(1).optional()),
  MAP_SEED: blankIsMissing(z.string().min(1).default('vettai-1')),
  IP_SALT: blankIsMissing(z.string().min(1).optional()),
  TRUST_PROXY: blankIsMissing(z.string().min(1).optional()),
  PUBLIC_WS_URL: blankIsMissing(z.string().url().optional()),
  VETTAI_PROCESS: blankIsMissing(z.string().min(1).optional()),
  REWARD_HUNT: blankIsMissing(nimAmount().optional()),
  REWARD_COURIER: blankIsMissing(nimAmount().optional()),
  REWARD_LANDMARKS: blankIsMissing(nimAmount().optional()),
  REWARD_LANDMARKS_REPEAT: blankIsMissing(nimAmount().optional()),
  REWARD_LANDLORD: blankIsMissing(nimAmount().optional()),
  LADDER_PRIZES_NIM: blankIsMissing(prizeList().optional()),
  LANDLORD_MIN_NIM: blankIsMissing(nimAmount().default('10')),
  LANDLORD_ENABLED: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
      z.enum(['true', 'false', '']).optional(),
    )
    .transform((value) => value === 'true'),
})

export type Config = z.infer<typeof schema>

/**
 * Reads the environment once and refuses to run on a bad one. The treasury check lives
 * here rather than in the sender because a treasury that boots without its key would
 * only fail at the moment it owes somebody money.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env)

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Bad or missing environment in ${resolve(serverRoot, '.env')}\n${lines.join('\n')}`)
  }

  if (isTreasuryProcess(env) && parsed.data.TREASURY_PRIVATE_KEY === undefined) {
    throw new Error('the treasury process needs TREASURY_PRIVATE_KEY and it is not set')
  }

  return parsed.data
}

export const config = parseConfig(process.env)

export const isTreasury: boolean = isTreasuryProcess(process.env)

/** The hard stop on everything Vettai will ever pay out, in luna. */
export const poolTotalLuna: bigint = nimToLuna(config.POOL_TOTAL_NIM)

/** What one wallet may take in a UTC day, across every reward kind, in luna. */
export const dailyCapLuna: bigint = nimToLuna(config.DAILY_CAP_NIM)

/** The stake that finishes the landlord quest, in luna. */
export const landlordMinLuna: bigint = nimToLuna(config.LANDLORD_MIN_NIM)

/**
 * The proxies whose X-Forwarded-For header is believed, in the form Fastify takes: a list
 * of addresses, subnets or the named ranges `loopback`, `linklocal` and `uniquelocal`.
 *
 * Blank trusts nobody, so the client IP is the address the packet really came from. That
 * is the right answer locally and the safe answer anywhere the container can be reached
 * without going through the edge. It is never `true`: trusting every hop lets a caller who
 * reaches the server directly name any IP it likes, and the IP is what bounds payouts per
 * household. Point `GET /api/echo-ip` at a deployment to check the value is right.
 */
export function trustedProxies(value: string | undefined = config.TRUST_PROXY): string[] | false {
  const hops = (value ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0)

  return hops.length > 0 ? hops : false
}

/**
 * The treasury key read straight off `.env.treasury`, for the one script that has to sign
 * as the treasury without being the treasury process. Everything else reads it from the
 * environment, which only the treasury has it in.
 */
export function treasuryKeyFromEnvFiles(): string | undefined {
  const fromEnvironment = (process.env['TREASURY_PRIVATE_KEY'] ?? '').trim()
  if (fromEnvironment !== '') return fromEnvironment

  let file: string
  try {
    file = readFileSync(treasuryEnvPath, 'utf8')
  } catch {
    return undefined
  }

  const key = (parseEnv(file)['TREASURY_PRIVATE_KEY'] ?? '').trim()
  return key === '' ? undefined : key
}

/**
 * Why the world must not start on this environment, or null when it may.
 *
 * The world is the process players can reach, and it is the one process that must never be
 * able to spend. A treasury key in its environment is one copied .env too many, which is a
 * mistake worth refusing to start on rather than logging and carrying on.
 */
export function worldBootRefusal(
  cfg: Pick<Config, 'TREASURY_PRIVATE_KEY'>,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (isTreasuryProcess(env)) {
    return 'VETTAI_PROCESS points at the treasury, so run npm run treasury, not the world'
  }

  if (cfg.TREASURY_PRIVATE_KEY !== undefined) {
    return (
      'TREASURY_PRIVATE_KEY is set here and the world must never hold it. That key belongs ' +
      'to the treasury process alone: move it to packages/server/.env.treasury and run ' +
      'npm run treasury with it.'
    )
  }

  return null
}

/** Browser origins allowed to call the API. Empty means same-origin only. */
export function allowedOrigins(): string[] {
  return (config.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}
