import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QuestView } from '../domain/quests.js'
import { LUNA_PER_NIM, lunaToNim } from '../lib/luna.js'
import { sleep } from '../lib/sleep.js'
import type { DroneWire, PlayerWire } from '../world/rooms.js'
import type { WorldMap } from '../world/types.js'
import type {
  Frame,
  HttpOptions,
  HttpResult,
  NodeReader,
  RunningWorld,
  ScriptedWallet,
  SignedIn,
  WorldSocket,
} from './support.js'

/**
 * The prove-it command, in two modes.
 *
 * Local (`npm run prove`) starts the real world in this process, plays it with a scripted
 * wallet through the real socket, and then attacks it: forged signatures, replays, somebody
 * else's quest, three caps, a short shop payment, a flood on the socket, and a payout the
 * treasury has already sent once. Every refusal is printed with the reason the server gave.
 * Testnet only, because it moves real test NIM out of a real wallet.
 *
 * Remote (`npm run prove -- --url https://...`) does the same to a deployment. Nothing runs
 * in this process and no key is needed: the run signs in over the network, plays the
 * deployed world through its own socket, claims, waits for the deployed treasury to pay,
 * and reads that payment back off the chain the deployment says it is on. The checks that
 * need the host's database or its configured caps are skipped rather than faked, and the
 * summary line counts them as skipped.
 *
 * The caps are turned down for a local run so all three can be crossed inside one pass.
 * Everything else is the code that is deployed.
 */

const TOTAL_CHECKS = 12

/**
 * The caps a local run uses instead of the ones in .env. A pool of 100 NIM cannot be proven
 * without spending 100 NIM, so it is turned down to something a single run can reach. A run
 * against a deployment never touches these: the host owns its own caps.
 */
export const CAP_OVERRIDES = {
  DAILY_CAP_NIM: '0.6',
  POOL_TOTAL_NIM: '1.2',
  IP_WALLETS_PER_DAY: '2',
} as const

export type CheckLine = {
  number: number
  title: string
  ok: boolean
  reason: string
  /** A check this mode cannot run. It is neither a pass nor a failure, and it is counted apart. */
  skipped?: boolean
}

/** One line a person can read: the number, the verdict, what was tried, and what happened. */
export function formatCheck(line: CheckLine, total: number = TOTAL_CHECKS): string {
  const counter = `${String(line.number).padStart(2, ' ')}/${total}`
  const verdict = line.skipped === true ? 'SKIP' : line.ok ? 'PASS' : 'FAIL'
  return `${counter}  ${verdict}  ${line.title}: ${line.reason}`
}

/**
 * The last line of a run. A clean local run has nothing to explain, so it stays the short
 * `12/12 passed` it has always been; anything skipped or failed prints all three numbers,
 * because a reader has to be told the difference between a check that was not run and a
 * check that was run and held.
 */
export function summaryLine(results: readonly CheckLine[], total: number = TOTAL_CHECKS): string {
  const skipped = results.filter((line) => line.skipped === true).length
  const failed = results.filter((line) => line.skipped !== true && !line.ok).length
  const passed = results.filter((line) => line.skipped !== true && line.ok).length

  if (skipped === 0 && failed === 0) return `${passed}/${total} passed`
  return `${passed}/${total} passed, ${skipped} skipped, ${failed} failed`
}

export type ProveMode = 'local' | 'remote'

export type ProveOptions = {
  mode: ProveMode
  /** The origin of the deployment under test, empty in local mode. */
  origin: string
  /** Remote only: spend from the treasury key on this machine so the shop check can run. */
  fund: boolean
  /** Remote only: the DAILY_CAP_NIM the deployment is supposed to be running. Empty means do not check. */
  expectDailyCap: string
}

function originOf(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`"${value}" is not a URL. Pass an origin, for example --url https://world.up.railway.app`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`"${value}" is not an http or https URL`)
  }
  return url.origin
}

/**
 * What the command was asked to do. `--url` (or VETTAI_PROVE_URL) picks a deployment and
 * with it the remote mode; without one the run is the local one that has always been here.
 */
export function readArguments(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ProveOptions {
  const values = new Map<string, string>()
  const flags = new Set<string>()

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === undefined || !name.startsWith('--')) continue
    const key = name.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) flags.add(key)
    else values.set(key, next)
  }

  const written = flags.has('url') ? '' : values.get('url')
  const asked = (written ?? env['VETTAI_PROVE_URL'] ?? '').trim()
  const expectDailyCap = (values.get('expect-daily-cap') ?? '').trim()

  if (asked === '') {
    if (flags.has('url')) {
      throw new Error('--url needs the origin of a deployment, for example --url https://world.up.railway.app')
    }
    return { mode: 'local', origin: '', fund: flags.has('fund'), expectDailyCap }
  }

  return { mode: 'remote', origin: originOf(asked), fund: flags.has('fund'), expectDailyCap }
}

/** The name of the file this run is written to, one per minute, sortable by name. */
export function proofFileName(now: Date, mode: ProveMode = 'local'): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-')
  return mode === 'remote' ? `prove-remote-${stamp}.txt` : `prove-${stamp}.txt`
}

/**
 * True when an address is one no caller on the internet could have arrived from, so the
 * world is describing a machine on its own side rather than the player. It covers
 * 10.0.0.0/8, the carrier grade range 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16 and
 * loopback, which is the whole of RFC 1918 plus what Railway and Fly put in front of a
 * container.
 *
 * It is a label, not the test. A hosting edge with a public address, which is what Railway
 * answers with today, passes every one of these and is still the wrong address: the check
 * that catches that compares what the world saw with this machine's own egress address. It
 * does NOT judge IPv6.
 */
export function looksLikeProxyHop(ip: string): boolean {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return false

  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false

  const [first = -1, second = -1] = octets
  if (first === 10 || first === 127) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  return first === 192 && second === 168
}

/** Where this machine leaves the internet from, read from a service outside the deployment. */
export const EGRESS_URL = 'https://api.ipify.org'

/** Plain text, one address. Anything else is a failure rather than a value to compare. */
export function readEgressAddress(text: string): string {
  const seen = text.trim()
  if (!/^[0-9a-fA-F.:]{3,45}$/.test(seen)) {
    throw new Error(`${EGRESS_URL} answered "${seen.slice(0, 40)}", which is not an address`)
  }
  return seen
}

async function egressAddress(): Promise<string> {
  const response = await fetch(EGRESS_URL, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${EGRESS_URL} answered ${response.status}`)
  return readEgressAddress(await response.text())
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function demand(ok: boolean, complaint: string): void {
  if (!ok) throw new Error(complaint)
}

const nim = (luna: bigint): string => `${lunaToNim(luna)} NIM`

const here = dirname(fileURLToPath(import.meta.url))
const proofsFolder = resolve(here, '../../../../docs/proofs')

/** What the checks need on chain, in luna, before a local run is worth starting. */
const MINIMUM_TREASURY_LUNA = 5n * LUNA_PER_NIM

/** What the treasury lends wallet A so it can pay for its own gear. */
const SHOP_FUNDING_LUNA = 150_000n

/** A deliberately short payment, enough to exist on chain and nowhere near a price. */
const SHORT_PAYMENT_LUNA = 1_000n

const HUNT_SECONDS = 240
const REMOTE_HUNT_SECONDS = 300
const LANDMARK_SECONDS = 300

/** How long a run waits for a deployed treasury to pay a queued claim. */
const PAID_WAIT_MS = 240_000

/** The gap between two reads of /api/claims. Ten reads a minute sits inside the host's limit. */
const CLAIM_POLL_MS = 6_000

/** How long a run waits for a deployed watcher to settle a shop payment. */
const SHOP_WAIT_MS = 240_000

/** A deployment allows ten sign-ins a minute from one address, so a refused burst waits this out. */
const RATE_WINDOW_WAIT_MS = 62_000

const FLOOD_MOVES = 40

/** Six metres a second is the walk speed, and a second of measurement is never exact. */
const MOVE_CAP_METRES = 7

/** Enough movement to prove the intent was accepted at all, rather than blocked by a wall. */
const MOVE_FLOOR_METRES = 0.5

const FIRE_FRAMES = 20

/** The stock blaster's own limit, which is what the simulation holds a shooter to. */
const SHOTS_PER_SECOND = 4

/** Where a player's eye sits, matching EYE_HEIGHT in the simulation. */
const EYE_HEIGHT = 1.6

/** Close enough to shoot with room to spare inside the 60 m hitscan. */
const AIM_RANGE = 40

type Support = typeof import('./support.js')
type Sign = (typeof import('../nimiq/verify.js'))['signWithKeyPair']
type RunBot = (typeof import('./bot.js'))['runBot']

/**
 * What a check is pointed at: a world in this process, or a deployment across the network.
 * The modules come in on this object because a local run has to set its caps in the
 * environment before anything can reach config.ts, so nothing that reads config may be
 * imported at the top of this file.
 */
type Target = {
  kind: ProveMode
  base: string
  say: (line: string) => void
  support: Support
  sign: Sign
}

type Session = { wallet: ScriptedWallet; token: string; address: string; ip: string }

/**
 * One call at the target. A local run picks the address it calls from, because every
 * per-IP rule keys on it and one loopback address is not enough to prove them. A remote
 * run has one address and cannot choose, so the choice is dropped here rather than at
 * every call site.
 */
function ask<T>(
  target: Target,
  path: string,
  options: HttpOptions & { ip?: string } = {},
): Promise<HttpResult<T>> {
  const { ip, ...rest } = options
  return target.support.httpJson<T>(target.base, path, {
    ...rest,
    ...(target.kind === 'local' && ip !== undefined ? { localAddress: ip } : {}),
  })
}

async function signInPatiently(target: Target, wallet: ScriptedWallet, ip: string): Promise<SignedIn> {
  const from = target.kind === 'local' ? ip : undefined

  try {
    return await target.support.signIn(target.base, wallet, from)
  } catch (error) {
    if (target.kind === 'local' || !/too many requests/i.test(reasonOf(error))) throw error
    target.say('     the host is rate limiting sign-ins, waiting for its next minute')
    await sleep(RATE_WINDOW_WAIT_MS)
    return target.support.signIn(target.base, wallet, from)
  }
}

async function newPlayer(target: Target, ip = '127.0.0.1'): Promise<Session> {
  const wallet = target.support.scriptedWallet()
  const session = await signInPatiently(target, wallet, ip)
  return { wallet, token: session.token, address: session.address, ip }
}

async function questsOf(target: Target, player: Session): Promise<QuestView[]> {
  const today = await ask<{ quests: QuestView[] }>(target, '/api/quests/today', {
    token: player.token,
    ip: player.ip,
  })
  demand(today.status === 200, `could not read the quests: ${today.raw}`)
  return today.body.quests
}

function questNamed(rows: readonly QuestView[], kind: QuestView['kind']): QuestView {
  const quest = rows.find((row) => row.kind === kind)
  if (!quest) throw new Error(`there is no ${kind} quest today`)
  return quest
}

type ClaimAnswer = {
  status: number
  state?: string
  reason?: string
  memo?: string
  error?: string
  claimId?: string
}

async function claimQuest(target: Target, player: Session, questId: string): Promise<ClaimAnswer> {
  const challenge = await ask<{ message: string; error?: string }>(
    target,
    `/api/quests/${questId}/claim/challenge`,
    { method: 'POST', body: {}, token: player.token, ip: player.ip },
  )
  if (challenge.status !== 200) {
    return { status: challenge.status, ...(challenge.body.error ? { error: challenge.body.error } : {}) }
  }

  const signed = target.sign(player.wallet.keyPair, challenge.body.message)
  const sent = await ask<ClaimAnswer>(target, `/api/quests/${questId}/claim`, {
    method: 'POST',
    body: {
      message: challenge.body.message,
      publicKey: signed.publicKeyHex,
      signature: signed.signatureHex,
    },
    token: player.token,
    ip: player.ip,
  })

  return { ...sent.body, status: sent.status }
}

/** Check 2, in both modes: a wallet signs in and the server reads its address off the key. */
async function proveSignIn(target: Target): Promise<{ player: Session; replayable: SignedIn; reason: string }> {
  const wallet = target.support.scriptedWallet()
  const session = await signInPatiently(target, wallet, '127.0.0.1')

  demand(
    session.address === wallet.address,
    `the server said ${session.address} and the key derives ${wallet.address}`,
  )

  const me = await ask<{ address: string }>(target, '/api/me', { token: session.token })
  demand(me.status === 200, `/api/me answered ${me.status}`)
  demand(me.body.address === wallet.address, `/api/me said ${me.body.address}`)

  return {
    player: { wallet, token: session.token, address: session.address, ip: '127.0.0.1' },
    replayable: session,
    reason: `${wallet.address} signed in, /api/me agrees, nothing named an address but the key`,
  }
}

/** Check 3, in both modes: a forged signature and a replayed challenge are both refused. */
async function proveForgeryRefused(
  target: Target,
  holder: Session,
  replayable: SignedIn,
): Promise<string> {
  const challenge = await ask<{ message: string }>(target, '/api/auth/challenge', {
    method: 'POST',
    body: {},
  })
  const imposter = target.support.scriptedWallet()
  const wrong = target.sign(imposter.keyPair, challenge.body.message)

  const forged = await ask<{ error: string }>(target, '/api/auth/verify', {
    method: 'POST',
    body: {
      message: challenge.body.message,
      publicKey: holder.wallet.keyPair.publicKey.toHex(),
      signature: wrong.signatureHex,
    },
  })
  demand(forged.status === 401, `a forged signature was answered with ${forged.status}`)

  const replay = await ask<{ error: string }>(target, '/api/auth/verify', {
    method: 'POST',
    body: { message: replayable.message, publicKey: replayable.publicKey, signature: replayable.signature },
  })
  demand(replay.status === 401, `a replayed login was answered with ${replay.status}`)

  return `forged signature 401 "${forged.body.error}", replayed challenge 401 "${replay.body.error}"`
}

/** Check 4, in both modes: a scripted wallet plays the real world until the hunt quest is done. */
async function playUntilHuntIsDone(
  target: Target,
  player: Session,
  seconds: number,
  runBot: RunBot,
): Promise<{ quest: QuestView; reason: string }> {
  const from = Date.now()
  const rows = await runBot({
    baseUrl: target.base,
    keyPair: player.wallet.keyPair,
    seconds,
    until: (quests) => (quests.find((quest) => quest.kind === 'hunt')?.progress ?? 0) >= 5,
  })
  const elapsed = Math.round((Date.now() - from) / 1000)

  const hunt = questNamed(rows, 'hunt')
  demand(hunt.progress >= 5, `only ${hunt.progress} kills in ${elapsed}s`)
  demand(hunt.state === 'done', `the hunt is ${hunt.state}, not done`)

  return {
    quest: hunt,
    reason: `${hunt.progress} kills in ${elapsed}s through the socket, reward ${nim(BigInt(hunt.rewardLuna))}`,
  }
}

/** Check 5, in both modes: the claim is signed once, and a replay or another wallet is refused. */
async function proveClaimedOnce(
  target: Target,
  player: Session,
  questId: string,
): Promise<{ claimId: string; memo: string; other: Session; reason: string }> {
  const challenge = await ask<{ message: string }>(target, `/api/quests/${questId}/claim/challenge`, {
    method: 'POST',
    body: {},
    token: player.token,
    ip: player.ip,
  })
  demand(challenge.status === 200, `the claim challenge answered ${challenge.status}`)

  const signed = target.sign(player.wallet.keyPair, challenge.body.message)
  const body = {
    message: challenge.body.message,
    publicKey: signed.publicKeyHex,
    signature: signed.signatureHex,
  }

  const first = await ask<ClaimAnswer>(target, `/api/quests/${questId}/claim`, {
    method: 'POST',
    body,
    token: player.token,
    ip: player.ip,
  })
  demand(first.status === 200, `the claim answered ${first.status}: ${first.raw}`)
  demand(first.body.state === 'queued', `the claim came back ${String(first.body.state)}`)
  demand(/^vettai:[0-9a-f]{8}$/.test(first.body.memo ?? ''), `the memo is "${String(first.body.memo)}"`)

  const replay = await ask<ClaimAnswer>(target, `/api/quests/${questId}/claim`, {
    method: 'POST',
    body,
    token: player.token,
    ip: player.ip,
  })
  demand(replay.status === 409, `the replayed claim answered ${replay.status}`)

  const other = await newPlayer(target, player.ip)
  const thief = await claimQuest(target, other, questId)
  demand(thief.status === 404, `another wallet claiming this quest answered ${thief.status}`)

  return {
    claimId: first.body.claimId ?? '',
    memo: first.body.memo ?? '',
    other,
    reason: `queued with memo ${String(first.body.memo)}, replay 409 "${String(replay.body.error)}", another wallet 404`,
  }
}

type ClaimView = {
  id: string
  state: string
  memo: string
  amountLuna: string
  txHash: string | null
  blockNumber: number | null
  error: string | null
}

/**
 * Waits for a deployment's own treasury to pay a claim, reading only what the API says.
 * A claim that comes back held or failed stops the wait: waiting longer would not change
 * it, and the reason the host gave is worth more than a timeout.
 */
async function waitForPayment(
  target: Target,
  player: Session,
  claimId: string,
  timeoutMs: number,
): Promise<ClaimView> {
  const until = Date.now() + timeoutMs
  let seen = 'unknown'

  for (;;) {
    const answer = await ask<{ claims: ClaimView[] }>(target, '/api/claims', {
      token: player.token,
      ip: player.ip,
    })

    if (answer.status === 200) {
      const row = answer.body.claims.find((claim) => claim.id === claimId)
      if (!row) throw new Error(`the deployment does not list claim ${claimId}`)

      if (row.state !== seen) {
        seen = row.state
        target.say(`     claim ${claimId} is ${row.state}`)
      }
      if (row.state === 'paid' && row.txHash !== null && row.blockNumber !== null) return row
      if (row.state === 'held' || row.state === 'failed') {
        throw new Error(`the claim came back ${row.state}: ${String(row.error)}`)
      }
    }

    if (Date.now() > until) {
      throw new Error(`the claim was still ${seen} after ${Math.round(timeoutMs / 1000)}s`)
    }
    await sleep(CLAIM_POLL_MS)
  }
}

/** Runs a flaky measurement again rather than failing a check on one unlucky second. */
async function attempt<T>(times: number, body: (round: number) => Promise<T>): Promise<T> {
  let last: unknown = new Error('nothing was attempted')

  for (let round = 0; round < times; round += 1) {
    try {
      return await body(round)
    } catch (error) {
      last = error
      await sleep(1_500)
    }
  }

  throw last instanceof Error ? last : new Error(String(last))
}

type SelfView = {
  at: () => { x: number; z: number }
  downed: () => boolean
  drones: () => DroneWire[]
  hitsSince: (from: number) => number
}

/**
 * The player's own picture of itself, read out of the frames the server sends. A run
 * against a deployment cannot look inside its rooms, so everything check 11 measures
 * remotely comes from the wire: where the server says this player is, and which of this
 * player's shots the server says landed.
 *
 * The world names players by a room handle and never by a wallet address, so the handle in
 * the welcome is the only thing that can pick this player out of a state frame.
 */
function followSelf(socket: WorldSocket, welcome: Frame): SelfView {
  const you = welcome['you'] as { handle?: string } | undefined
  const me = typeof you?.handle === 'string' ? you.handle : ''
  if (me === '') throw new Error('the welcome did not name this player with a handle')

  let at = { x: 0, z: 0 }
  let downed = false
  let drones: DroneWire[] = []
  const hits: number[] = []

  function readPlayers(list: unknown): void {
    if (!Array.isArray(list)) return
    for (const entry of list as PlayerWire[]) {
      if (entry.id !== me) continue
      at = { x: entry.x, z: entry.z }
      downed = entry.downed
    }
  }

  readPlayers(welcome['players'])
  drones = (welcome['drones'] as DroneWire[]) ?? []

  socket.onFrame((frame) => {
    if (frame.t !== 'state') return
    readPlayers(frame['players'])
    drones = (frame['drones'] as DroneWire[]) ?? drones

    const events = frame['events']
    if (!Array.isArray(events)) return
    for (const event of events as { kind: string; player?: string }[]) {
      if (event.player === me && (event.kind === 'hit' || event.kind === 'kill')) hits.push(Date.now())
    }
  })

  return {
    at: () => at,
    downed: () => downed,
    drones: () => drones,
    hitsSince: (from) => hits.filter((when) => when >= from).length,
  }
}

async function openSocketFor(target: Target, player: Session): Promise<WorldSocket> {
  const ticket = await ask<{ ticket: string }>(target, '/api/world/ticket', { token: player.token })
  demand(ticket.status === 200, `the socket ticket answered ${ticket.status}`)

  const socket = await target.support.openWorldSocket(
    `${target.base.replace('http', 'ws')}/ws?ticket=${ticket.body.ticket}`,
  )
  await socket.waitForKind('welcome')
  return socket
}

/** Check 11 against a deployment, measured from the wire instead of from the room. */
async function proveSocketLimitsRemote(target: Target, bot: typeof import('./bot.js')): Promise<string> {
  const player = await newPlayer(target)
  const map = (await ask<WorldMap>(target, '/api/world/map')).body

  const ticket = await ask<{ ticket: string }>(target, '/api/world/ticket', { token: player.token })
  demand(ticket.status === 200, `the socket ticket answered ${ticket.status}`)
  const socket = await target.support.openWorldSocket(
    `${target.base.replace('http', 'ws')}/ws?ticket=${ticket.body.ticket}`,
  )
  const welcome = await socket.waitForKind('welcome')
  const world = followSelf(socket, welcome)

  const headings = [
    { dx: 0, dz: 1 },
    { dx: 1, dz: 0 },
    { dx: 0, dz: -1 },
    { dx: -1, dz: 0 },
  ]

  let flooded = ''
  let stretched = ''
  let landed = 0

  try {
    flooded = await attempt(headings.length, async (round) => {
      const heading = headings[round % headings.length] ?? headings[0]
      if (!heading) throw new Error('there is no heading to walk')

      await sleep(1_100)
      const from = world.at()
      for (let n = 0; n < FLOOD_MOVES; n += 1) {
        socket.send({ t: 'move', dx: heading.dx, dz: heading.dz, yaw: 0 })
      }
      await sleep(1_000)
      socket.send({ t: 'move', dx: 0, dz: 0, yaw: 0 })

      const to = world.at()
      const walked = Math.hypot(to.x - from.x, to.z - from.z)
      demand(!world.downed(), 'a drone downed the player while the walk was being measured')
      demand(walked >= MOVE_FLOOR_METRES, `the player covered ${walked.toFixed(2)} m, so a wall was in the way`)
      demand(walked <= MOVE_CAP_METRES, `the player covered ${walked.toFixed(2)} m in a second`)
      return `${FLOOD_MOVES} moves in a second carried the player ${walked.toFixed(2)} m, inside the 6 m/s walk`
    })

    stretched = await attempt(headings.length, async (round) => {
      const heading = headings[round % headings.length] ?? headings[0]
      if (!heading) throw new Error('there is no heading to walk')

      await sleep(1_100)
      const from = world.at()
      socket.send({ t: 'move', dx: heading.dx * 50, dz: heading.dz * 50, yaw: 0 })
      await sleep(1_000)
      socket.send({ t: 'move', dx: 0, dz: 0, yaw: 0 })

      const to = world.at()
      const ran = Math.hypot(to.x - from.x, to.z - from.z)
      demand(!world.downed(), 'a drone downed the player while the long move was being measured')
      demand(ran >= MOVE_FLOOR_METRES, `the player covered ${ran.toFixed(2)} m, so a wall was in the way`)
      demand(ran <= MOVE_CAP_METRES, `a move of length 50 carried the player ${ran.toFixed(2)} m in a second`)
      return `a move vector of length 50 carried it ${ran.toFixed(2)} m, so the server normalised it`
    })

    landed = await attempt(3, async () => {
      const found = await walkIntoAim(socket, world, map, bot)
      const eye = { x: world.at().x, y: EYE_HEIGHT, z: world.at().z }
      const aim = bot.aimAt(eye, found)

      const firedFrom = Date.now()
      for (let n = 0; n < FIRE_FRAMES; n += 1) socket.send({ t: 'fire', yaw: aim.yaw, pitch: aim.pitch })
      await sleep(1_200)

      const hits = world.hitsSince(firedFrom)
      demand(hits >= 1, `${FIRE_FRAMES} fire frames landed nothing, so the rate was never measured`)
      demand(hits <= SHOTS_PER_SECOND, `${hits} shots were accepted in one second`)
      return hits
    })
  } finally {
    socket.close()
  }

  const second = await openSocketFor(target, player)
  second.sendRaw('not json at all')
  second.sendRaw('{"v":1}')
  second.sendRaw('{"v":1,"t":"teleport"}')
  const closed = await second.waitForClose(5_000)
  demand(closed.code === 1008, `the socket closed with ${closed.code}`)

  return (
    `${flooded}; ${stretched}; ${FIRE_FRAMES} fire frames gave ${landed} landed shot(s) on an mk1; ` +
    `three bad frames closed the socket with ${closed.code}`
  )
}

/**
 * Walks until a live drone is inside blaster range with nothing in the way, and answers
 * with where it is. Without a target the fire rate cannot be measured from outside: the
 * server only reports a shot that hit something.
 */
async function walkIntoAim(
  socket: WorldSocket,
  world: SelfView,
  map: WorldMap,
  bot: typeof import('./bot.js'),
  timeoutMs = 60_000,
): Promise<DroneWire> {
  const until = Date.now() + timeoutMs

  for (;;) {
    const me = world.at()
    const target = bot.pickTarget(map, me, world.drones())

    if (target) {
      const eye = { x: me.x, y: EYE_HEIGHT, z: me.z }
      if (bot.horizontalRange(me, target) <= AIM_RANGE && bot.canSee(map, eye, target)) {
        socket.send({ t: 'move', dx: 0, dz: 0, yaw: 0 })
        return target
      }
      const step = bot.stepToward(me, target)
      socket.send({ t: 'move', dx: step.dx, dz: step.dz, yaw: Math.atan2(target.x - me.x, target.z - me.z) })
    }

    if (Date.now() > until) throw new Error('no drone came into range in a minute')
    await sleep(100)
  }
}

/** Check 11 locally, where the room itself can be read and the refusals counted directly. */
async function proveSocketLimitsLocal(target: Target, world: RunningWorld): Promise<string> {
  // A wallet of its own, carrying the stock mk1 blaster. Wallet A bought the mk2 two
  // checks ago and that raises its own fire rate to six, which would make the four below
  // the wrong bar to hold the server to.
  const player = await newPlayer(target)

  const socket = await openSocketFor(target, player)

  const room = world.rooms.roomFor(player.address)
  demand(room !== null, 'the player is in no room')
  const positionAt = (): { x: number; z: number } => {
    const live = world.rooms.roomFor(player.address)?.state.players.get(player.address)
    if (!live) throw new Error('the player left the world')
    return { x: live.x, z: live.z }
  }

  const droppedBefore = world.rooms.dropped(player.address) ?? 0
  const from = positionAt()
  for (let n = 0; n < FLOOD_MOVES; n += 1) socket.send({ t: 'move', dx: 0, dz: 1, yaw: 0 })
  await sleep(1000)
  const to = positionAt()
  const walked = Math.hypot(to.x - from.x, to.z - from.z)
  const droppedMoves = (world.rooms.dropped(player.address) ?? 0) - droppedBefore

  demand(walked <= MOVE_CAP_METRES, `the player covered ${walked.toFixed(2)} m in a second`)
  demand(droppedMoves >= 10, `only ${droppedMoves} of the ${FLOOD_MOVES} moves were dropped`)

  await sleep(1100)
  socket.send({ t: 'move', dx: 50, dz: 0, yaw: 0 })
  await sleep(250)
  const intent = world.rooms.roomFor(player.address)?.state.players.get(player.address)?.intent
  demand(intent !== undefined, 'the player has no intent')
  const length = Math.hypot(intent?.dx ?? 0, intent?.dz ?? 0)
  demand(Math.abs(length - 1) < 1e-6, `a dx of 50 was stored as a vector of length ${length}`)

  await sleep(1100)
  for (let n = 0; n < FIRE_FRAMES; n += 1) socket.send({ t: 'fire', yaw: 0, pitch: 0 })
  await sleep(300)
  const shooter = world.rooms.roomFor(player.address)?.state.players.get(player.address)
  const accepted = (shooter?.recentFires ?? []).filter((at) => at > Date.now() - 1000).length
  demand(accepted <= SHOTS_PER_SECOND, `${accepted} shots were accepted in one second`)
  socket.close()

  const rude = await openSocketFor(target, player)
  rude.sendRaw('not json at all')
  rude.sendRaw('{"v":1}')
  rude.sendRaw('{"v":1,"t":"teleport"}')
  const closed = await rude.waitForClose(5000)
  demand(closed.code === 1008, `the socket closed with ${closed.code}`)

  return (
    `${FLOOD_MOVES} moves in a second: ${droppedMoves} dropped and ${walked.toFixed(2)} m covered, under the 6 m/s cap; ` +
    `dx 50 stored as a unit vector; ${FIRE_FRAMES} fire frames gave ${accepted} accepted shots on an mk1; ` +
    `three bad frames closed the socket with ${closed.code}`
  )
}

type Run = {
  say: (line: string) => void
  lines: string[]
  results: CheckLine[]
  check: (number: number, title: string, body: () => Promise<string>) => Promise<boolean>
  skip: (number: number, title: string, reason: string) => void
  halt: (why: string) => void
}

function startRun(): Run {
  const lines: string[] = []
  const results: CheckLine[] = []
  let halted: string | null = null

  function say(line: string): void {
    lines.push(line)
    console.log(line)
  }

  function record(line: CheckLine): void {
    results.push(line)
    say(formatCheck(line))
  }

  return {
    say,
    lines,
    results,
    halt: (why) => {
      halted = why
    },
    skip: (number, title, reason) => record({ number, title, ok: true, reason, skipped: true }),
    check: async (number, title, body) => {
      if (halted !== null) {
        record({ number, title, ok: false, reason: halted })
        return false
      }
      try {
        record({ number, title, ok: true, reason: await body() })
        return true
      } catch (error) {
        record({ number, title, ok: false, reason: reasonOf(error) })
        return false
      }
    },
  }
}

async function runLocal(run: Run, started: Date): Promise<void> {
  const { config, dailyCapLuna, poolTotalLuna, treasuryKeyFromEnvFiles } = await import('../config.js')
  const treasuryKey = treasuryKeyFromEnvFiles()

  if (config.NIMIQ_NETWORK !== 'TestAlbatross') {
    throw new Error(
      `refusing to run: NIMIQ_NETWORK is ${config.NIMIQ_NETWORK} and this command only runs on TestAlbatross`,
    )
  }
  if (!treasuryKey) {
    throw new Error('refusing to run: TREASURY_PRIVATE_KEY is not in .env.treasury, so nothing can be paid')
  }

  const { and, asc, eq, isNull } = await import('drizzle-orm')
  const { openMemoryDb } = await import('../db/client.js')
  const { applyMigrations } = await import('../db/migrate.js')
  const { claims, shopOrders } = await import('../db/schema.js')
  const { signWithKeyPair } = await import('../nimiq/verify.js')
  const { ipHash } = await import('../routes/context.js')
  const rpc = await import('../nimiq/rpc.js')
  const { deliverOnce } = await import('../treasury/outbox.js')
  const { assertTreasuryConfig } = await import('../treasury/refuse.js')
  const { createSender } = await import('../treasury/sender.js')
  const watcher = await import('../treasury/watcher.js')
  const { runBot } = await import('./bot.js')
  const support = await import('./support.js')

  const handle = await openMemoryDb()
  await applyMigrations(handle)
  const db = handle.db

  const world = await support.startWorld({ db })
  const target: Target = {
    kind: 'local',
    base: world.url,
    say: run.say,
    support,
    sign: signWithKeyPair,
  }

  const treasury = createSender({
    privateKeyHex: treasuryKey,
    network: config.NIMIQ_NETWORK,
    rpc,
  })

  run.say(`vettai prove-it, ${started.toISOString()}`)
  run.say(`world ${target.base}, database pglite in memory, node ${config.NIMIQ_RPC_URL}`)
  run.say(
    `caps for this run: daily ${nim(dailyCapLuna)}, pool ${nim(poolTotalLuna)}, ` +
      `${config.IP_WALLETS_PER_DAY} wallets per IP per day`,
  )
  run.say('')

  async function committedTotals(address: string): Promise<{ today: bigint; ever: bigint }> {
    const rows = await db.select().from(claims)
    const live = rows.filter((row) => ['queued', 'sending', 'sent', 'paid'].includes(row.state))
    const ever = live.reduce((total, row) => total + row.amountLuna, 0n)
    const today = live
      .filter((row) => row.address === address)
      .reduce((total, row) => total + row.amountLuna, 0n)
    return { today, ever }
  }

  /** Wallets other than this one that have claimed from the same source address today. */
  async function walletsFromIp(ip: string, exclude: string): Promise<number> {
    const rows = await db.select().from(claims)
    const hash = ipHash(ip)
    const wallets = new Set(
      rows.filter((row) => row.ipHash === hash && row.address !== exclude).map((row) => row.address),
    )
    return wallets.size
  }

  async function claimRow(claimId: string) {
    const [row] = await db.select().from(claims).where(eq(claims.id, claimId)).limit(1)
    if (!row) throw new Error(`claim ${claimId} is not in the database`)
    return row
  }

  /** Waits for the node's address index to catch up, which lags the hash lookup by a block or two. */
  async function waitIndexed(address: string, hash: string, timeoutMs = 90_000): Promise<void> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const page = await rpc.getTransactionsByAddress(address, 25, null).catch(() => [])
      if (page.some((row) => row.hash === hash)) return
      if (Date.now() > until) throw new Error(`the node never indexed ${hash} against ${address}`)
      await sleep(3000)
    }
  }

  let walletA: Session | null = null
  let walletB: Session | null = null
  let replayable: SignedIn | null = null
  let huntQuestId = ''
  let huntClaimId = ''
  let huntRewardLuna = 0n

  const identified = await run.check(
    1,
    'the node and the treasury are the ones we say they are',
    async () => {
      const head = await rpc.getLatestBlock()
      demand(head.network === 'TestAlbatross', `the node reports ${head.network}, not TestAlbatross`)

      const identity = await assertTreasuryConfig({
        privateKeyHex: treasuryKey,
        expectedAddress: config.TREASURY_ADDRESS,
        network: config.NIMIQ_NETWORK,
        rpc,
      })

      const account = await rpc.getAccountByAddress(identity.address)
      const balance = BigInt(account.balance)
      demand(
        balance >= MINIMUM_TREASURY_LUNA,
        `the treasury holds ${nim(balance)}, which is under the ${nim(MINIMUM_TREASURY_LUNA)} this run needs`,
      )

      return `${head.network} at block ${head.number}, key derives ${identity.address}, balance ${nim(balance)}`
    },
  )

  // A node on the wrong chain or a treasury that cannot be identified means nothing below
  // is safe to try, so the run stops rather than spending anything to find that out again.
  if (!identified) run.halt('not run, because check 1 could not identify the node or the treasury')

  await run.check(2, 'a wallet signs in and the server reads its address off the key', async () => {
    const signedIn = await proveSignIn(target)
    walletA = signedIn.player
    // The replayed login below needs the exact bytes this sign-in used.
    replayable = signedIn.replayable
    return signedIn.reason
  })

  await run.check(3, 'a forged signature and a replayed challenge are both refused', async () => {
    const holder = walletA
    const used = replayable
    if (!holder || !used) throw new Error('wallet A never signed in')
    return proveForgeryRefused(target, holder, used)
  })

  await run.check(4, 'a scripted wallet plays the real world until the hunt quest is done', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const played = await playUntilHuntIsDone(target, player, HUNT_SECONDS, runBot)
    huntQuestId = played.quest.id
    huntRewardLuna = BigInt(played.quest.rewardLuna)
    return played.reason
  })

  await run.check(5, 'the hunt claim is signed once, and a replay or another wallet is refused', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const claimed = await proveClaimedOnce(target, player, huntQuestId)
    huntClaimId = claimed.claimId
    walletB = claimed.other
    return claimed.reason
  })

  await run.check(6, 'the treasury pays it on chain and the payment carries the quest id', async () => {
    const summary = await deliverOnce(db, treasury, new Date(), { log: (line) => run.say(`     ${line}`) })
    demand(summary.sent >= 1, `the outbox sent ${summary.sent} payouts`)

    // A payment is only called paid once a full batch sits on top of it, so this waits for
    // the chain rather than for the broadcast. That wait is the point: it is what stops the
    // treasury calling a payment final before the chain has.
    const until = Date.now() + PAID_WAIT_MS
    let row = await claimRow(huntClaimId)
    while (row.state !== 'paid' && Date.now() < until) {
      await sleep(CLAIM_POLL_MS)
      await deliverOnce(db, treasury, new Date(), { log: () => {} })
      row = await claimRow(huntClaimId)
    }

    demand(row.state === 'paid', `the claim is ${row.state}, not paid`)
    demand(row.txHash !== null, 'the claim has no transaction hash')
    demand(row.blockNumber !== null, 'the claim has no block number')

    const onChain = await rpc.getTransactionByHash(row.txHash ?? '')
    const recipient = onChain.to.replace(/\s+/g, '').toUpperCase()
    const memo = rpc.decodeMemo(onChain.recipientData)

    demand(recipient === walletA?.address, `the payment went to ${recipient}`)
    demand(BigInt(onChain.value) === huntRewardLuna, `the payment was ${nim(BigInt(onChain.value))}`)
    demand(memo === row.memo, `the memo on chain is "${String(memo)}"`)

    return `${nim(BigInt(onChain.value))} to ${recipient}, memo "${String(memo)}", hash ${row.txHash}, block ${String(row.blockNumber)}`
  })

  await run.check(7, 'the daily cap holds the claim that would cross it', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const rows = await runBot({
      baseUrl: target.base,
      keyPair: player.wallet.keyPair,
      seconds: LANDMARK_SECONDS,
      until: (quests) => quests.find((quest) => quest.kind === 'landmarks')?.state !== 'open',
    })

    const landmarks = questNamed(rows, 'landmarks')
    demand(landmarks.state === 'done', `the landmarks quest is ${landmarks.state} after the walk`)

    const before = await committedTotals(player.address)

    const held = await claimQuest(target, player, landmarks.id)
    demand(held.status === 200, `the landmarks claim answered ${held.status}`)
    demand(held.state === 'held', `the landmarks claim came back ${String(held.state)}`)
    demand(held.reason === 'daily cap', `it was held for "${String(held.reason)}"`)

    const streak = questNamed(rows, 'streak')
    const alsoHeld = await claimQuest(target, player, streak.id)
    demand(alsoHeld.state === 'held', `the streak claim came back ${String(alsoHeld.state)}`)
    demand(alsoHeld.reason === 'daily cap', `the streak claim was held for "${String(alsoHeld.reason)}"`)

    return (
      `${nim(before.today)} already committed today, ${nim(BigInt(landmarks.rewardLuna))} more crosses ` +
      `the ${nim(dailyCapLuna)} cap, landmarks and streak both held for "daily cap"`
    )
  })

  await run.check(8, 'the third wallet claiming from one address is held', async () => {
    const second = walletB
    if (!second) throw new Error('wallet B never signed in')

    const bQuests = await questsOf(target, second)
    const bStreak = questNamed(bQuests, 'streak')
    const bClaim = await claimQuest(target, second, bStreak.id)
    demand(bClaim.state === 'queued', `the second wallet came back ${String(bClaim.state)}`)

    const third = await newPlayer(target, '127.0.0.1')
    const seenBefore = await walletsFromIp(third.ip, third.address)
    const cStreak = questNamed(await questsOf(target, third), 'streak')
    const cClaim = await claimQuest(target, third, cStreak.id)

    const fourth = await newPlayer(target, '127.0.0.1')
    const dStreak = questNamed(await questsOf(target, fourth), 'streak')
    const dClaim = await claimQuest(target, fourth, dStreak.id)

    demand(seenBefore === config.IP_WALLETS_PER_DAY, `${seenBefore} wallets had claimed from this address`)
    demand(cClaim.state === 'held', `the third wallet came back ${String(cClaim.state)}`)
    demand(cClaim.reason === 'ip cap', `the third wallet was held for "${String(cClaim.reason)}"`)
    demand(dClaim.reason === 'ip cap', `the fourth wallet was held for "${String(dClaim.reason)}"`)

    return (
      `wallets 1 and 2 from 127.0.0.1 were queued, ${seenBefore} distinct wallets had claimed, ` +
      `wallets 3 and 4 held for "ip cap"`
    )
  })

  await run.check(9, 'the pool stops the claim that would spend past it', async () => {
    const totals: string[] = []
    let crossed: ClaimAnswer | null = null
    let crossingAmount = 0n

    // The per-IP rule would refuse a third wallet from one address before the pool was ever
    // reached, so these wallets come in from their own loopback addresses. That is the same
    // thing a farmer with a VPN does, which the threat model says plainly.
    for (const ip of ['127.0.0.2', '127.0.0.2', '127.0.0.3']) {
      const player = await newPlayer(target, ip)
      const streak = questNamed(await questsOf(target, player), 'streak')
      const before = await committedTotals(player.address)
      const amount = BigInt(streak.rewardLuna)

      const answer = await claimQuest(target, player, streak.id)
      totals.push(`${nim(before.ever)} + ${nim(amount)} -> ${String(answer.state)}`)

      if (answer.state === 'held') {
        crossed = answer
        crossingAmount = before.ever + amount
        break
      }
      demand(answer.state === 'queued', `a claim under the pool came back ${String(answer.state)}`)
    }

    demand(crossed !== null, `nothing crossed the ${nim(poolTotalLuna)} pool: ${totals.join(', ')}`)
    demand(crossed?.reason === 'pool', `the crossing claim was held for "${String(crossed?.reason)}"`)
    demand(crossingAmount > poolTotalLuna, `the crossing total was ${nim(crossingAmount)}`)

    return `${totals.join(', ')}; ${nim(crossingAmount)} is past the ${nim(poolTotalLuna)} pool`
  })

  await run.check(
    10,
    'a real shop payment grants the gear and a short one from another wallet does not',
    async () => {
      const buyer = walletA
      const other = walletB
      if (!buyer || !other) throw new Error('wallet A or B never signed in')

      const funding = await treasury.send({
        to: buyer.address,
        valueLuna: SHOP_FUNDING_LUNA,
        memo: 'vettai:prove:float',
      })
      const funded = await treasury.waitInclusion(funding.hash, 120_000)
      demand('blockNumber' in funded, 'the float to wallet A never landed in a block')

      const order = await ask<{ orderId: string; memo: string; luna: string; to: string }>(
        target,
        '/api/shop/orders',
        { method: 'POST', body: { item: 'blaster-mk2' }, token: buyer.token, ip: buyer.ip },
      )
      demand(order.status === 200, `the order answered ${order.status}: ${order.raw}`)

      const decoy = await ask<{ orderId: string; memo: string }>(target, '/api/shop/orders', {
        method: 'POST',
        body: { item: 'blaster-mk2' },
        token: other.token,
        ip: other.ip,
      })
      demand(decoy.status === 200, `the second order answered ${decoy.status}`)

      const buyerSender = createSender({
        privateKeyHex: buyer.wallet.privateKeyHex,
        network: config.NIMIQ_NETWORK,
        rpc,
      })

      const payment = await buyerSender.send({
        to: config.TREASURY_ADDRESS,
        valueLuna: BigInt(order.body.luna),
        memo: order.body.memo,
      })
      const short = await buyerSender.send({
        to: config.TREASURY_ADDRESS,
        valueLuna: SHORT_PAYMENT_LUNA,
        memo: decoy.body.memo,
      })

      const landed = await buyerSender.waitInclusion(payment.hash, 120_000)
      demand('blockNumber' in landed, 'the shop payment never landed in a block')
      await buyerSender.waitInclusion(short.hash, 120_000)

      await waitIndexed(config.TREASURY_ADDRESS, payment.hash)
      await waitIndexed(config.TREASURY_ADDRESS, short.hash)

      // The watcher acts on a payment only once a full batch sits on top of its block, so
      // this waits for the chain the way the treasury does instead of settling on sight. A
      // shallower block can still be dropped, and gear is not something a player gives back.
      const until = Date.now() + SHOP_WAIT_MS
      let settled = 0
      let waited = 0

      for (;;) {
        const pass = await watcher.tick(db, rpc, { log: (line) => run.say(`     ${line}`) })
        settled += pass.paid
        if (settled >= 1) break
        if (Date.now() > until) {
          throw new Error(`the watcher settled nothing in ${Math.round(SHOP_WAIT_MS / 1000)}s`)
        }
        waited += 1
        await sleep(CLAIM_POLL_MS)
      }

      run.say(`     the watcher settled the order after ${waited} pass(es) waiting for the batch`)

      const view = await ask<{ state: string }>(target, `/api/shop/orders/${order.body.orderId}`, {
        token: buyer.token,
        ip: buyer.ip,
      })
      demand(view.body.state === 'paid', `the order is ${view.body.state}`)

      const me = await ask<{ gear: { blaster: string } }>(target, '/api/me', { token: buyer.token })
      demand(me.body.gear.blaster === 'mk2', `the gear says ${me.body.gear.blaster}`)

      const [decoyRow] = await db
        .select()
        .from(shopOrders)
        .where(eq(shopOrders.id, decoy.body.orderId))
        .limit(1)
      demand(decoyRow?.state === 'pending', `the underpaid order is ${String(decoyRow?.state)}`)

      return (
        `paid ${nim(BigInt(order.body.luna))} with memo ${order.body.memo}, hash ${payment.hash}, gear now mk2; ` +
        `${nim(SHORT_PAYMENT_LUNA)} from the wrong wallet on ${decoy.body.memo} left the order pending`
      )
    },
  )

  await run.check(11, 'the socket refuses a flood, a long move vector and nonsense frames', () =>
    proveSocketLimitsLocal(target, world),
  )

  await run.check(12, 'a payout that already has a hash is looked up, never sent again', async () => {
    const queued = await db
      .select()
      .from(claims)
      .where(eq(claims.state, 'queued'))
      .orderBy(asc(claims.createdAt))
    demand(queued.length > 0, 'there is nothing queued to measure a pass against')

    const decoy = queued[0]
    if (!decoy) throw new Error('there is nothing queued to measure a pass against')

    const fakeHash = randomBytes(32).toString('hex')
    await db
      .update(claims)
      .set({ state: 'sending', txHash: fakeHash, sentAt: new Date() })
      .where(and(eq(claims.id, decoy.id), eq(claims.state, 'queued')))

    const stillQueued = queued.slice(1)
    const balanceBefore = BigInt((await rpc.getAccountByAddress(config.TREASURY_ADDRESS)).balance)

    const summary = await deliverOnce(db, treasury, new Date(), { log: (line) => run.say(`     ${line}`) })

    // Anything broadcast but not yet in a block is settled by a second pass, which has no
    // queued rows left to send, so the balance below is measured against a finished ledger.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const waiting = await db
        .select()
        .from(claims)
        .where(and(eq(claims.state, 'sent'), isNull(claims.blockNumber)))
      if (waiting.length === 0) break
      await sleep(3000)
      await deliverOnce(db, treasury, new Date(), { log: () => {} })
    }

    const balanceAfter = BigInt((await rpc.getAccountByAddress(config.TREASURY_ADDRESS)).balance)
    const spent = balanceBefore - balanceAfter

    const after = await claimRow(decoy.id)
    demand(after.state === 'sending', `the claim with a fake hash is now ${after.state}`)
    demand(after.txHash === fakeHash, 'the claim with a fake hash was signed again')
    demand(after.blockNumber === null, 'a made up hash was reported as being in a block')

    // What left the wallet is what reached a block, which is not the same as what has been
    // called paid: a payment waits a full batch on top of it before the treasury says that.
    let expected = 0n
    for (const row of stillQueued) {
      expected += (await claimRow(row.id)).blockNumber !== null ? row.amountLuna : 0n
    }

    demand(spent === expected, `the treasury fell by ${nim(spent)} against ${nim(expected)} of payouts on chain`)

    return (
      `${summary.sent} payout(s) left in this pass; the claim holding a made up hash stayed "sending" and was ` +
      `not signed again; the treasury fell by ${nim(spent)}, exactly the payouts of this pass that reached a block`
    )
  })

  const finalBalance = BigInt((await rpc.getAccountByAddress(config.TREASURY_ADDRESS)).balance)
  run.say('')
  run.say(`treasury ${config.TREASURY_ADDRESS} now holds ${nim(finalBalance)}`)

  await world.stop()
  await handle.close()
}

async function runRemote(options: ProveOptions, run: Run, started: Date): Promise<void> {
  const { signWithKeyPair } = await import('../nimiq/verify.js')
  const { decodeMemo } = await import('../nimiq/rpc.js')
  const { treasuryKeyFromEnvFiles } = await import('../config.js')
  const { createSender } = await import('../treasury/sender.js')
  const bot = await import('./bot.js')
  const support = await import('./support.js')

  const target: Target = {
    kind: 'remote',
    base: options.origin,
    say: run.say,
    support,
    sign: signWithKeyPair,
  }

  run.say(`vettai prove-it against a deployment, ${started.toISOString()}`)
  run.say(`origin ${options.origin}`)
  run.say('nothing runs in this process: every check is made over the network')
  run.say('')

  let node: NodeReader | null = null
  let network = ''
  let dailyCapNim = ''
  let walletA: Session | null = null
  let walletB: Session | null = null
  let replayable: SignedIn | null = null
  let huntQuestId = ''
  let huntRewardLuna = 0n
  let huntClaimId = ''

  const reachable = await run.check(
    1,
    'the deployment answers, names its network, and sees the caller it should',
    async () => {
      const health = await ask<{
        ok: boolean
        network: string
        rooms: number
        online: number
        dailyCapNim?: string
      }>(target, '/health')
      demand(health.status === 200, `/health answered ${health.status}: ${health.raw}`)
      demand(health.body.ok === true, `/health answered ${health.raw}`)
      network = health.body.network
      dailyCapNim = String(health.body.dailyCapNim ?? '')

      node = support.readNode(support.publicNodeFor(network))
      const head = await node.getLatestBlock()
      demand(
        head.network === network,
        `the deployment says ${network} and ${node.url} says its head block is ${head.network}`,
      )

      const echo = await ask<{ ip: string }>(target, '/api/echo-ip')
      demand(echo.status === 200, `/api/echo-ip answered ${echo.status}`)
      const seen = String(echo.body.ip)

      // The only honest test of TRUST_PROXY is whether the world names the machine that
      // called it. A hosting edge is not always a private address, so "does it look private"
      // passed for months while every player was being counted as one household. This asks a
      // service outside the deployment what this machine's address is and compares the two.
      const mine = await egressAddress()
      const label = looksLikeProxyHop(seen) ? ', a range no caller could arrive from' : ''
      demand(
        seen === mine,
        `the world sees this caller as ${seen}${label} and ${EGRESS_URL} sees this machine as ` +
          `${mine}. The world is reading a hop on its own side, so the per-IP cap counts the ` +
          `whole internet as one household. If both are really this machine, they left on ` +
          `different address families`,
      )

      const map = await ask<{ version: string }>(target, '/api/world/map')
      demand(map.status === 200, `/api/world/map answered ${map.status}`)
      demand(typeof map.body.version === 'string', 'the map came back without a version')

      return (
        `${network} at block ${head.number} through ${node.url}, ${health.body.rooms} room(s) and ` +
        `${health.body.online} online, it reads this caller as ${seen}, which is this machine's own ` +
        `address, map ${map.body.version}`
      )
    },
  )

  if (!reachable) run.halt('not run, because check 1 could not reach the deployment')

  await run.check(2, 'a wallet signs in and the deployment reads its address off the key', async () => {
    const signedIn = await proveSignIn(target)
    walletA = signedIn.player
    replayable = signedIn.replayable
    return signedIn.reason
  })

  await run.check(3, 'a forged signature and a replayed challenge are both refused', async () => {
    const holder = walletA
    const used = replayable
    if (!holder || !used) throw new Error('wallet A never signed in')
    return proveForgeryRefused(target, holder, used)
  })

  await run.check(4, 'a scripted wallet plays the deployed world until the hunt quest is done', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const played = await playUntilHuntIsDone(target, player, REMOTE_HUNT_SECONDS, bot.runBot)
    huntQuestId = played.quest.id
    huntRewardLuna = BigInt(played.quest.rewardLuna)
    return played.reason
  })

  await run.check(5, 'the hunt claim is signed once, and a replay or another wallet is refused', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const claimed = await proveClaimedOnce(target, player, huntQuestId)
    huntClaimId = claimed.claimId
    walletB = claimed.other
    return claimed.reason
  })

  await run.check(6, 'the deployed treasury pays it on chain and the payment carries the quest id', async () => {
    const player = walletA
    const reader = node
    if (!player) throw new Error('wallet A never signed in')
    if (!reader) throw new Error('there is no node to read the payment from')

    const paid = await waitForPayment(target, player, huntClaimId, PAID_WAIT_MS)

    const onChain = await reader.getTransactionByHash(paid.txHash ?? '')
    const recipient = onChain.to.replace(/\s+/g, '').toUpperCase()
    const memo = decodeMemo(onChain.recipientData)

    demand(recipient === player.address, `the payment went to ${recipient}`)
    demand(BigInt(onChain.value) === huntRewardLuna, `the payment was ${nim(BigInt(onChain.value))}`)
    demand(memo === paid.memo, `the memo on chain is "${String(memo)}" and the claim says "${paid.memo}"`)
    demand(
      onChain.blockNumber === paid.blockNumber,
      `the deployment recorded block ${String(paid.blockNumber)} and the chain says ${onChain.blockNumber}`,
    )

    return (
      `${nim(BigInt(onChain.value))} to ${recipient}, memo "${String(memo)}", hash ${String(paid.txHash)}, ` +
      `block ${String(paid.blockNumber)} on ${network}, read back from ${reader.url}`
    )
  })

  // The cap itself cannot be crossed against a deployment without spending the deployment's
  // whole daily allowance, but the number it is running can be read and held to what Ram
  // meant to deploy. A cap that quietly went up is the same loss as a cap that is not there.
  if (options.expectDailyCap === '') {
    run.skip(
      7,
      'the deployment runs the daily cap Ram set',
      `remote: pass --expect-daily-cap to hold it to a number. The deployment says ${dailyCapNim || 'nothing'}`,
    )
  } else {
    await run.check(7, 'the deployment runs the daily cap Ram set', async () => {
      demand(dailyCapNim !== '', '/health does not report dailyCapNim, so the cap cannot be read')
      demand(
        dailyCapNim === options.expectDailyCap,
        `the deployment is running DAILY_CAP_NIM=${dailyCapNim} and this run expected ${options.expectDailyCap}`,
      )
      return `DAILY_CAP_NIM is ${dailyCapNim} NIM, which is what was expected`
    })
  }

  const capsAreTheHosts = 'remote: caps are configured on the host'
  run.skip(8, 'the third wallet claiming from one address is held', capsAreTheHosts)
  run.skip(9, 'the pool stops the claim that would spend past it', capsAreTheHosts)

  if (!options.fund) {
    run.skip(
      10,
      'a real shop payment grants the gear and a short one from another wallet does not',
      'remote: funding a fresh wallet needs the treasury key, so this one only runs with --fund',
    )
  } else {
    await run.check(
      10,
      'a real shop payment grants the gear and a short one from another wallet does not',
      async () => {
        const buyer = walletA
        const other = walletB
        const reader = node
        if (!buyer || !other) throw new Error('wallet A or B never signed in')
        if (!reader) throw new Error('there is no node to send payments through')

        const treasuryKey = treasuryKeyFromEnvFiles()
        if (!treasuryKey) throw new Error('--fund needs TREASURY_PRIVATE_KEY in .env.treasury')

        const treasury = createSender({ privateKeyHex: treasuryKey, network, rpc: reader })

        const order = await ask<{ orderId: string; memo: string; luna: string; to: string }>(
          target,
          '/api/shop/orders',
          { method: 'POST', body: { item: 'blaster-mk2' }, token: buyer.token },
        )
        demand(order.status === 200, `the order answered ${order.status}: ${order.raw}`)
        demand(
          order.body.to.replace(/\s+/g, '').toUpperCase() === treasury.address,
          `the deployment takes payments at ${order.body.to} and the key here is ${treasury.address}, ` +
            `so this run cannot fund a wallet for it`,
        )

        const decoy = await ask<{ orderId: string; memo: string }>(target, '/api/shop/orders', {
          method: 'POST',
          body: { item: 'blaster-mk2' },
          token: other.token,
        })
        demand(decoy.status === 200, `the second order answered ${decoy.status}`)

        const funding = await treasury.send({
          to: buyer.address,
          valueLuna: BigInt(order.body.luna) + SHOP_FUNDING_LUNA,
          memo: 'vettai:prove:float',
        })
        const funded = await treasury.waitInclusion(funding.hash, 180_000)
        demand('blockNumber' in funded, 'the float to wallet A never landed in a block')

        const buyerSender = createSender({
          privateKeyHex: buyer.wallet.privateKeyHex,
          network,
          rpc: reader,
        })

        const payment = await buyerSender.send({
          to: order.body.to,
          valueLuna: BigInt(order.body.luna),
          memo: order.body.memo,
        })
        const short = await buyerSender.send({
          to: order.body.to,
          valueLuna: SHORT_PAYMENT_LUNA,
          memo: decoy.body.memo,
        })

        const landed = await buyerSender.waitInclusion(payment.hash, 180_000)
        demand('blockNumber' in landed, 'the shop payment never landed in a block')
        await buyerSender.waitInclusion(short.hash, 180_000)

        const until = Date.now() + SHOP_WAIT_MS
        let state = 'pending'
        for (;;) {
          const view = await ask<{ state: string }>(target, `/api/shop/orders/${order.body.orderId}`, {
            token: buyer.token,
          })
          if (view.status === 200) state = view.body.state
          if (state === 'paid') break
          if (Date.now() > until) throw new Error(`the deployed watcher left the order ${state}`)
          await sleep(CLAIM_POLL_MS)
        }

        const me = await ask<{ gear: { blaster: string } }>(target, '/api/me', { token: buyer.token })
        demand(me.body.gear.blaster === 'mk2', `the gear says ${me.body.gear.blaster}`)

        const decoyView = await ask<{ state: string }>(target, `/api/shop/orders/${decoy.body.orderId}`, {
          token: other.token,
        })
        demand(decoyView.body.state === 'pending', `the underpaid order is ${decoyView.body.state}`)

        return (
          `paid ${nim(BigInt(order.body.luna))} with memo ${order.body.memo}, hash ${payment.hash}, gear now mk2; ` +
          `${nim(SHORT_PAYMENT_LUNA)} from the wrong wallet on ${decoy.body.memo} left that order pending`
        )
      },
    )
  }

  await run.check(11, 'the socket refuses a flood, a long move vector and nonsense frames', () =>
    proveSocketLimitsRemote(target, bot),
  )

  run.skip(
    12,
    'a payout that already has a hash is looked up, never sent again',
    'remote: the outbox is proven against its own database, which only the host can read',
  )
}

async function main(options: ProveOptions): Promise<number> {
  const started = new Date()
  const run = startRun()

  try {
    if (options.mode === 'remote') await runRemote(options, run, started)
    else await runLocal(run, started)
  } catch (error) {
    run.say(reasonOf(error))
    return 1
  }

  run.say('')
  run.say(summaryLine(run.results))
  for (const line of run.results.filter((row) => row.skipped !== true && !row.ok)) {
    run.say(`  still failing: ${formatCheck(line)}`)
  }
  run.say(`finished in ${Math.round((Date.now() - started.getTime()) / 1000)}s`)

  await mkdir(proofsFolder, { recursive: true })
  const file = resolve(proofsFolder, proofFileName(started, options.mode))
  await writeFile(file, `${run.lines.join('\n')}\n`, 'utf8')
  console.log(`written to ${file}`)

  return run.results.some((line) => line.skipped !== true && !line.ok) ? 1 : 0
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  let asked: ProveOptions
  try {
    asked = readArguments(process.argv.slice(2))
  } catch (error) {
    console.error(reasonOf(error))
    process.exit(1)
  }

  // The caps have to be in the environment before config.ts reads it, so everything that
  // can reach config.ts is imported inside the runners. dotenv leaves a key that is already
  // set alone. A run against a deployment never sets them: the host owns its own caps.
  if (asked.mode === 'local') {
    for (const [key, value] of Object.entries(CAP_OVERRIDES)) process.env[key] = value
  }

  process.exit(await main(asked))
}
