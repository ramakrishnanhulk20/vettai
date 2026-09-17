import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseEnv } from 'dotenv'
import { formatAddress, normalizeAddress } from '../lib/address.js'
import { lunaToNim, nimToLuna } from '../lib/luna.js'
import { assertTreasuryConfig } from '../treasury/refuse.js'
import { createSender, MAX_MEMO_BYTES, type SenderRpc } from '../treasury/sender.js'

/**
 * Sends what is left in the treasury wallet to an address you name.
 *
 * Ram funds the treasury from his phone and cannot export the key again, so this is the
 * way the money comes back out. It keeps the habits a payout has: the key is read from
 * the treasury's own env file and never printed, the key has to derive the address the
 * environment says it pays from, the node has to be on the network the environment says
 * it is on, and nothing is signed until `--yes` is written. Without `--yes` it prints the
 * plan and stops, which is the run to do first.
 *
 * `TREASURY_ENV_FILE` points it at another env file, the mainnet one for example, so the
 * same command empties either wallet without either key ever moving.
 */

const VALUE_OPTIONS = new Set(['to', 'amount', 'memo'])
const FLAG_OPTIONS = new Set(['yes'])

const USAGE = 'npm run treasury:sweep -- --to <address> [--amount <NIM>] [--memo <text>] [--yes]'

/** The memo that rides along when nobody writes one, so the payment is recognisable on chain. */
export const DEFAULT_MEMO = 'vettai treasury sweep'

/** How long the run waits for the payment to reach a block before it gives up and says so. */
export const WAIT_MS = 120_000

export type SweepArguments = {
  /** Exactly as it was typed. Whether it is an address at all is decided in planSweep. */
  to: string
  /** An amount of NIM as a person writes it, or null for everything in the wallet. */
  amount: string | null
  memo: string
  yes: boolean
}

/**
 * Reads the command line, or throws with the reason it cannot.
 *
 * An unknown option is refused rather than ignored, because a typed `--ammount 0.1` that
 * was quietly dropped would send the whole balance instead of a tenth of a NIM. A value
 * written in several words is joined back together, so a Nimiq address pasted in its
 * spaced form does not have to be quoted.
 */
export function parseSweepArguments(argv: readonly string[]): SweepArguments {
  const written = new Map<string, string>()

  let index = 0
  while (index < argv.length) {
    const token = argv[index] ?? ''

    if (!token.startsWith('--')) {
      throw new Error(`"${token}" has no option in front of it. Usage: ${USAGE}`)
    }

    const name = token.slice(2)
    if (written.has(name)) throw new Error(`--${name} was written twice`)

    if (FLAG_OPTIONS.has(name)) {
      written.set(name, 'yes')
      index += 1
      continue
    }

    if (!VALUE_OPTIONS.has(name)) {
      throw new Error(`--${name} is not an option this command knows. Usage: ${USAGE}`)
    }

    const parts: string[] = []
    index += 1
    while (index < argv.length && !(argv[index] ?? '').startsWith('--')) {
      parts.push(argv[index] ?? '')
      index += 1
    }

    if (parts.length === 0) throw new Error(`--${name} needs a value. Usage: ${USAGE}`)
    written.set(name, parts.join(' '))
  }

  const to = written.get('to')
  if (to === undefined) throw new Error(`--to needs the address the money goes to. Usage: ${USAGE}`)

  return {
    to,
    amount: written.get('amount') ?? null,
    memo: written.get('memo') ?? DEFAULT_MEMO,
    yes: written.has('yes'),
  }
}

export type SweepPlan = {
  network: string
  from: string
  to: string
  balanceLuna: bigint
  valueLuna: bigint
  memo: string
  /** True when the plan empties the wallet, which is what an amount nobody wrote means. */
  whole: boolean
}

/**
 * Turns what was asked for into what will be signed, or throws the reason it will not be.
 *
 * Every refusal lives here rather than next to the signing, so the dry run is held to
 * exactly the same rules as the real send and a plan that printed is a plan that would
 * go through.
 */
export function planSweep(input: {
  network: string
  from: string
  to: string
  amount: string | null
  memo: string
  balanceLuna: bigint
}): SweepPlan {
  const from = normalizeAddress(input.from)
  if (!from) throw new Error(`the treasury key derives ${input.from}, which is not a Nimiq address`)

  const to = normalizeAddress(input.to)
  if (!to) throw new Error(`"${input.to}" is not a Nimiq address`)

  if (from === to) {
    throw new Error('the treasury would be paying itself. Name an address the money should end up at')
  }

  const memoBytes = new TextEncoder().encode(input.memo).byteLength
  if (memoBytes > MAX_MEMO_BYTES) {
    throw new Error(`the memo is ${memoBytes} bytes and Nimiq carries ${MAX_MEMO_BYTES}`)
  }

  if (input.balanceLuna <= 0n) {
    throw new Error(`there is nothing to sweep: ${formatAddress(from)} holds 0 NIM`)
  }

  const valueLuna = input.amount === null ? input.balanceLuna : nimToLuna(input.amount)

  if (valueLuna <= 0n) throw new Error('the amount has to be more than nothing')
  if (valueLuna > input.balanceLuna) {
    throw new Error(
      `the amount is ${lunaToNim(valueLuna)} NIM and the wallet holds ${lunaToNim(input.balanceLuna)} NIM`,
    )
  }

  return {
    network: input.network,
    from,
    to,
    balanceLuna: input.balanceLuna,
    valueLuna,
    memo: input.memo,
    whole: valueLuna === input.balanceLuna,
  }
}

function row(label: string, value: string): string {
  return `${label.padEnd(10, ' ')}${value}`
}

/** The plan as a person reads it. The same lines print on a dry run and on a real send. */
export function formatPlan(plan: SweepPlan): string[] {
  const left = plan.balanceLuna - plan.valueLuna
  const tail = plan.whole ? 'the whole balance' : `leaving ${lunaToNim(left)} NIM`

  return [
    row('network', plan.network),
    row('from', formatAddress(plan.from)),
    row('to', formatAddress(plan.to)),
    row('balance', `${lunaToNim(plan.balanceLuna)} NIM`),
    row('sending', `${lunaToNim(plan.valueLuna)} NIM (${tail})`),
    row('memo', plan.memo === '' ? '(none)' : plan.memo),
  ]
}

export type SweepRpc = SenderRpc & {
  getNetworkName: () => Promise<string>
  getAccountByAddress: (address: string) => Promise<{ balance: number }>
}

/** A balance the node did not give as a whole number of luna is refused rather than rounded. */
export function balanceLuna(account: { balance: number }): bigint {
  if (!Number.isInteger(account.balance) || account.balance < 0) {
    throw new Error(`the node reported a balance of ${account.balance}, which is not a whole number of luna`)
  }
  return BigInt(account.balance)
}

export type SweepRun = {
  privateKeyHex: string
  expectedAddress: string
  network: string
  rpc: SweepRpc
  args: SweepArguments
  say: (line: string) => void
  timeoutMs?: number
  /** Only tests change this. The chain does not produce blocks faster than the default. */
  pollMs?: number
}

/**
 * Checks, prints, and only then signs. Returns the exit code: 0 when the money is in a
 * block, 1 for every refusal, for a dry run, and for a wait that ran out.
 *
 * A dry run exits 1 on purpose. Forgetting `--yes` in a script must never read as a sweep
 * that happened.
 */
export async function runSweep(run: SweepRun): Promise<number> {
  const identity = await assertTreasuryConfig({
    privateKeyHex: run.privateKeyHex,
    expectedAddress: run.expectedAddress,
    network: run.network,
    rpc: run.rpc,
  })

  const plan = planSweep({
    network: identity.network,
    from: identity.address,
    to: run.args.to,
    amount: run.args.amount,
    memo: run.args.memo,
    balanceLuna: balanceLuna(await run.rpc.getAccountByAddress(identity.address)),
  })

  for (const line of formatPlan(plan)) run.say(line)

  if (plan.network === 'MainAlbatross') run.say('this is mainnet, so the NIM is real')

  if (!run.args.yes) {
    run.say('')
    run.say('nothing was sent. Run the same command again with --yes to send it')
    return 1
  }

  const sender = createSender({
    privateKeyHex: run.privateKeyHex,
    network: run.network,
    rpc: run.rpc,
    ...(run.pollMs === undefined ? {} : { pollMs: run.pollMs }),
  })

  run.say('')

  let hash: string
  try {
    const sent = await sender.send({
      to: plan.to,
      valueLuna: plan.valueLuna,
      memo: plan.memo,
      onSigned: (signed) => run.say(`hash      ${signed}`),
    })
    hash = sent.hash
  } catch (error) {
    run.say(`the node did not take the broadcast: ${reasonOf(error)}`)
    run.say('look the hash above up before sending anything again')
    return 1
  }

  const waitMs = run.timeoutMs ?? WAIT_MS
  const inclusion = await sender.waitInclusion(hash, waitMs)

  if ('pending' in inclusion) {
    run.say(`still not in a block after ${Math.round(waitMs / 1000)}s`)
    run.say('the hash above is the one to look up. Do not send it again until you have')
    return 1
  }

  run.say(`block     ${inclusion.blockNumber}`)
  run.say(`sent      ${lunaToNim(plan.valueLuna)} NIM to ${formatAddress(plan.to)}`)
  return 0
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type TreasuryCredentials = { privateKeyHex: string | null; address: string | null }

/** The key and the address as they sit in an env file. Neither is trusted further than refuse.ts. */
export function credentialsFromEnvFile(contents: string): TreasuryCredentials {
  const values = parseEnv(contents)
  const key = (values['TREASURY_PRIVATE_KEY'] ?? '').trim()
  const address = (values['TREASURY_ADDRESS'] ?? '').trim()

  return { privateKeyHex: key === '' ? null : key, address: address === '' ? null : address }
}

/** Where TREASURY_ENV_FILE points, read against the server package so a bare filename works. */
export function treasuryEnvFileFrom(env: Record<string, string | undefined>, root: string): string | null {
  const written = (env['TREASURY_ENV_FILE'] ?? '').trim()
  if (written === '') return null
  return isAbsolute(written) ? written : resolve(root, written)
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseSweepArguments(argv)

  // config.ts reads the environment the moment it is imported, so it is pulled in here
  // rather than at the top of the file: the tests get the parsing and the refusals
  // without needing a .env to exist.
  const { config, serverRoot, treasuryKeyFromEnvFiles } = await import('../config.js')
  const node = await import('../nimiq/rpc.js')
  const rpc: SweepRpc = {
    getBlockNumber: node.getBlockNumber,
    getNetworkName: node.getNetworkName,
    getAccountByAddress: node.getAccountByAddress,
    fetchTransaction: node.fetchTransaction,
    pushTransaction: node.pushTransaction,
  }

  const named = treasuryEnvFileFrom(process.env, serverRoot)

  let privateKeyHex: string | null
  let expectedAddress: string

  if (named === null) {
    privateKeyHex = treasuryKeyFromEnvFiles() ?? null
    expectedAddress = config.TREASURY_ADDRESS
  } else {
    let contents: string
    try {
      contents = readFileSync(named, 'utf8')
    } catch {
      throw new Error(`TREASURY_ENV_FILE points at ${named} and that file cannot be read`)
    }

    const found = credentialsFromEnvFile(contents)
    privateKeyHex = found.privateKeyHex
    // The address beside the key wins, so pointing at the mainnet file does not check a
    // mainnet key against the testnet address in .env.
    expectedAddress = found.address ?? config.TREASURY_ADDRESS
  }

  if (privateKeyHex === null) {
    throw new Error(
      named === null
        ? 'no treasury key was found. It belongs in packages/server/.env.treasury as TREASURY_PRIVATE_KEY'
        : `${named} has no TREASURY_PRIVATE_KEY in it`,
    )
  }

  return runSweep({
    privateKeyHex,
    expectedAddress,
    network: config.NIMIQ_NETWORK,
    rpc,
    args,
    say: (line) => console.log(line),
  })
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (error) {
    console.error(`refused: ${reasonOf(error)}`)
    process.exit(1)
  }
}
