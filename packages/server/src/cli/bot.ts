import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeyPair } from '@nimiq/core'
import type { QuestView } from '../domain/quests.js'
import { sleep } from '../lib/sleep.js'
import { segmentHitsBox } from '../world/geometry.js'
import type { BoltWire, DroneWire, PlayerWire } from '../world/rooms.js'
import type { FireIntent, MoveIntent, Place, Vec3, WorldMap } from '../world/types.js'
import { httpJson, openWorldSocket, signIn, type Frame, type WorldSocket } from './support.js'

/**
 * A scripted player.
 *
 * It holds a key pair, signs in the way a phone does, joins the real socket and sends the
 * same intents a thumb would: move, fire, interact. It is never told where it is or what it
 * hit. Everything it knows comes back out of the server's own `state` frames, which is the
 * point: a bot that can farm the game this way is the threat model's first attacker, and
 * the only thing standing between it and the treasury is the caps.
 */

/** Where a player's eye sits, matching EYE_HEIGHT in the simulation. */
const EYE_HEIGHT = 1.6

/** One decision every 100 ms. Ten moves a second sits well inside the socket's budget of 20. */
const STEP_MS = 100

/** The blaster's own limit is four shots a second, so asking faster only wastes frames. */
const FIRE_EVERY_MS = 250

const INTERACT_EVERY_MS = 300

/** How close the server wants a player to be before an interact counts, less a safety margin. */
const INTERACT_RANGE = 2

/** Beyond this the bot walks closer rather than shooting, well inside the 60 m hitscan. */
const FIRE_RANGE = 50

/** A bolt that will pass this close is worth stepping out of the way of. */
const DODGE_MISS_DISTANCE = 1.6

/** How far ahead a bolt is looked at. Past this it is somebody else's problem. */
const DODGE_LOOKAHEAD_SECONDS = 1.2

/** Movement under this over the watch below means the way ahead is blocked. */
const STUCK_DISTANCE = 0.6
const STUCK_WATCH_MS = 1200
const DETOUR_MS = 1400

export type TrackedBolt = { id: string; x: number; y: number; z: number; vx: number; vz: number }

/**
 * Where to point to hit something, as the simulation reads it: yaw 0 looks along +z and
 * pitch is positive upward. The eye is the origin, not the feet, because that is where the
 * server starts the shot from.
 */
export function aimAt(eye: Vec3, target: Vec3): FireIntent {
  const dx = target.x - eye.x
  const dy = target.y - eye.y
  const dz = target.z - eye.z
  const flat = Math.hypot(dx, dz)

  return { yaw: Math.atan2(dx, dz), pitch: flat === 0 && dy === 0 ? 0 : Math.atan2(dy, flat) }
}

export function horizontalRange(from: Place, to: Place): number {
  return Math.hypot(to.x - from.x, to.z - from.z)
}

/**
 * True when nothing is standing between the eye and the target. The client has the same
 * map the server does, so it can work out its own line of sight rather than firing at a
 * roof and wondering why nothing happened.
 */
export function canSee(map: WorldMap, eye: Vec3, target: Vec3): boolean {
  for (const building of map.buildings) {
    if (segmentHitsBox(eye, target, building.aabb, 0, building.height)) return false
  }
  return true
}

/** The closest live drone this player could actually hit, or null when there is none. */
export function pickTarget(map: WorldMap, me: Place, drones: DroneWire[]): DroneWire | null {
  const eye = { x: me.x, y: EYE_HEIGHT, z: me.z }
  let best: DroneWire | null = null
  let bestRange = Infinity

  for (const drone of drones) {
    if (drone.state === 'dead' || drone.hp <= 0) continue
    const range = horizontalRange(me, drone)
    if (range >= bestRange) continue
    if (range <= FIRE_RANGE && !canSee(map, eye, drone)) continue
    best = drone
    bestRange = range
  }

  return best
}

/**
 * The sideways step that gets a player out of a bolt's way, or null when nothing is coming.
 *
 * The server never tells a client where a bolt is going, only where it is, so the speed
 * comes from watching the same bolt across two frames. A bolt already past the player, or
 * one that will miss anyway, is left alone: dodging everything would keep the bot walking
 * backwards and it would never reach a drone.
 */
export function dodgeFrom(me: Place, bolts: readonly TrackedBolt[]): MoveIntent | null {
  for (const bolt of bolts) {
    const speedSquared = bolt.vx * bolt.vx + bolt.vz * bolt.vz
    if (speedSquared < 1e-6) continue

    const relX = me.x - bolt.x
    const relZ = me.z - bolt.z

    const closing = relX * bolt.vx + relZ * bolt.vz
    if (closing <= 0) continue

    const seconds = closing / speedSquared
    if (seconds > DODGE_LOOKAHEAD_SECONDS) continue

    const missX = relX - bolt.vx * seconds
    const missZ = relZ - bolt.vz * seconds
    if (Math.hypot(missX, missZ) > DODGE_MISS_DISTANCE) continue

    const speed = Math.sqrt(speedSquared)
    const sideX = -bolt.vz / speed
    const sideZ = bolt.vx / speed
    // Step towards the side the player is already on, so the dodge is never a walk across
    // the bolt's own path.
    const sign = relX * sideX + relZ * sideZ >= 0 ? 1 : -1

    return { dx: sideX * sign, dz: sideZ * sign, yaw: Math.atan2(bolt.vx, bolt.vz) }
  }

  return null
}

/** A unit step from one place towards another, or a standstill when it is already there. */
export function stepToward(from: Place, to: Place): { dx: number; dz: number } {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-6) return { dx: 0, dz: 0 }
  return { dx: dx / length, dz: dz / length }
}

function questOf(quests: readonly QuestView[], kind: QuestView['kind']): QuestView | undefined {
  return quests.find((quest) => quest.kind === kind)
}

/** The closest landmark this player has not reached yet, so the tour is not a random walk. */
function nextLandmark(map: WorldMap, me: Place, quest: QuestView): { index: number; at: Place } | null {
  const visited = quest.visited ?? []
  let best: { index: number; at: Place } | null = null
  let bestRange = Infinity

  for (const [index, place] of map.landmarks.entries()) {
    if (visited[index] === true) continue
    const range = horizontalRange(me, place)
    if (range >= bestRange) continue
    best = { index, at: place }
    bestRange = range
  }

  return best
}

type Job =
  | { kind: 'hunt'; at: Place }
  | { kind: 'landmark'; at: Place; interact: string }
  | { kind: 'courier'; at: Place; interact: 'pickup' | 'deliver' }
  | { kind: 'idle'; at: Place }

/**
 * Where to walk next, in the order a player would care: close on a drone while the hunt is
 * open, then walk the landmarks, then run the parcel. Shooting is decided separately, so a
 * bot on its way to a landmark still defends itself instead of being knocked back to the
 * office every time it passes a patrol.
 */
function chooseJob(map: WorldMap, me: Place, drones: DroneWire[], quests: readonly QuestView[]): Job {
  const hunt = questOf(quests, 'hunt')
  if (hunt?.state === 'open') {
    const target = pickTarget(map, me, drones)
    if (target) return { kind: 'hunt', at: { x: target.x, z: target.z } }
  }

  const landmarks = questOf(quests, 'landmarks')
  if (landmarks?.state === 'open') {
    const next = nextLandmark(map, me, landmarks)
    if (next) return { kind: 'landmark', at: next.at, interact: `landmark:${next.index}` }
  }

  const courier = questOf(quests, 'courier')
  if (courier?.state === 'open' && courier.route) {
    const point = courier.carrying ? courier.route.to : courier.route.from
    const at = map.courier[point]
    if (at) return { kind: 'courier', at, interact: courier.carrying ? 'deliver' : 'pickup' }
  }

  const target = pickTarget(map, me, drones)
  if (target) return { kind: 'hunt', at: { x: target.x, z: target.z } }

  return { kind: 'idle', at: map.office }
}

export type BotOptions = {
  baseUrl: string
  keyPair: KeyPair
  seconds: number
  log?: (line: string) => void
  /** Stops the run early, as soon as the quest rows say what the caller was waiting for. */
  until?: (quests: QuestView[]) => boolean
}

/**
 * Reads the frames the world sends and keeps one picture of it. Everything the bot decides
 * with comes from here, so nothing it does depends on a number it made up.
 */
function watch(socket: WorldSocket, me: string) {
  const here: { x: number; z: number } = { x: 0, z: 0 }
  let drones: DroneWire[] = []
  let bolts: TrackedBolt[] = []
  let quests: QuestView[] = []
  let tick = 0

  function readPlayers(list: unknown): void {
    if (!Array.isArray(list)) return
    for (const entry of list as PlayerWire[]) {
      if (entry.id !== me) continue
      here.x = entry.x
      here.z = entry.z
    }
  }

  function readBolts(list: unknown, seconds: number): void {
    if (!Array.isArray(list)) return
    const previous = new Map(bolts.map((bolt) => [bolt.id, bolt]))
    bolts = (list as BoltWire[]).map((bolt) => {
      const before = previous.get(bolt.id)
      const vx = before && seconds > 0 ? (bolt.x - before.x) / seconds : 0
      const vz = before && seconds > 0 ? (bolt.z - before.z) / seconds : 0
      return { id: bolt.id, x: bolt.x, y: bolt.y, z: bolt.z, vx, vz }
    })
  }

  let lastStateAt = Date.now()

  socket.onFrame((frame: Frame) => {
    if (frame.t === 'welcome') {
      readPlayers(frame['players'])
      drones = (frame['drones'] as DroneWire[]) ?? []
      quests = (frame['quests'] as QuestView[]) ?? []
      return
    }

    if (frame.t === 'state') {
      const now = Date.now()
      readPlayers(frame['players'])
      drones = (frame['drones'] as DroneWire[]) ?? []
      readBolts(frame['bolts'], (now - lastStateAt) / 1000)
      lastStateAt = now
      tick = Number(frame['tick'] ?? tick)
      return
    }

    if (frame.t === 'event' && frame['kind'] === 'quest') {
      const updated = frame['quest'] as QuestView
      quests = [...quests.filter((quest) => quest.id !== updated.id), updated]
    }
  })

  return {
    me: here,
    drones: () => drones,
    bolts: () => bolts,
    quests: () => quests,
    tick: () => tick,
  }
}

/**
 * Signs in, joins the world and plays for as long as it is told to.
 *
 * Nothing here reports a result to the server. The bot asks to move and to fire; the
 * simulation decides what happened and writes the quest rows itself, which is why the rows
 * this returns are worth reading.
 */
export async function runBot(options: BotOptions): Promise<QuestView[]> {
  const log = options.log ?? (() => {})
  const { baseUrl, keyPair, seconds } = options

  const session = await signIn(baseUrl, { keyPair })
  const auth = { token: session.token }

  const map = (await httpJson<WorldMap>(baseUrl, '/api/world/map')).body
  const ticket = await httpJson<{ ticket: string }>(baseUrl, '/api/world/ticket', auth)
  if (ticket.status !== 200) throw new Error(`no socket ticket: ${ticket.raw}`)

  const socket = await openWorldSocket(`${baseUrl.replace('http', 'ws')}/ws?ticket=${ticket.body.ticket}`)
  const world = watch(socket, session.address)
  const welcome = await socket.waitForKind('welcome')

  log(`${session.address} joined room ${String(welcome['room'])}`)

  const until = Date.now() + seconds * 1000
  let firedAt = 0
  let interactedAt = 0
  let detourUntil = 0
  let detourSide = 1
  let watchedFrom = { x: world.me.x, z: world.me.z }
  let watchedAt = Date.now()

  while (Date.now() < until && socket.closed() === null) {
    const now = Date.now()
    const me = { x: world.me.x, z: world.me.z }
    const quests = world.quests()

    if (options.until?.(quests) === true) break

    const job = chooseJob(map, me, world.drones(), quests)

    let move = stepToward(me, job.at)
    let yaw = Math.atan2(job.at.x - me.x, job.at.z - me.z)

    // A bot that walks into a corner would stand there for the rest of the run, so a spell
    // of no progress turns into a sidestep and the next attempt comes in from another angle.
    if (now - watchedAt >= STUCK_WATCH_MS) {
      const travelled = horizontalRange(watchedFrom, me)
      if (travelled < STUCK_DISTANCE && now > detourUntil) {
        detourUntil = now + DETOUR_MS
        detourSide = -detourSide
      }
      watchedFrom = me
      watchedAt = now
    }

    if (now < detourUntil) {
      move = { dx: -move.dz * detourSide, dz: move.dx * detourSide }
    }

    const dodge = dodgeFrom(me, world.bolts())
    if (dodge) {
      move = { dx: dodge.dx, dz: dodge.dz }
    }

    // Anything in range gets shot at, whatever the bot is walking towards. A drone left
    // alone keeps firing, and a downed player wakes up at the office with the walk to do
    // again, so shooting back is what makes a long errand finish at all.
    const eye = { x: me.x, y: EYE_HEIGHT, z: me.z }
    const target = pickTarget(map, me, world.drones())
    if (target && horizontalRange(me, target) <= FIRE_RANGE && canSee(map, eye, target)) {
      const aim = aimAt(eye, target)
      if (job.kind === 'hunt') yaw = aim.yaw
      if (now - firedAt >= FIRE_EVERY_MS) {
        socket.send({ t: 'fire', yaw: aim.yaw, pitch: aim.pitch })
        firedAt = now
      }
    }

    if ((job.kind === 'landmark' || job.kind === 'courier') && now - interactedAt >= INTERACT_EVERY_MS) {
      if (horizontalRange(me, job.at) <= INTERACT_RANGE) {
        socket.send({ t: 'interact', target: job.interact })
        interactedAt = now
      }
    }

    socket.send({ t: 'move', dx: move.dx, dz: move.dz, yaw })

    await sleep(STEP_MS)
  }

  socket.close()

  const today = await httpJson<{ quests: QuestView[] }>(baseUrl, '/api/quests/today', auth)
  return today.body.quests ?? []
}

type CommandLine = { players: number; seconds: number; url: string }

export function readArguments(argv: readonly string[]): CommandLine {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === undefined || !name.startsWith('--')) continue
    values.set(name.slice(2), argv[index + 1] ?? '')
  }

  const players = Number(values.get('players') ?? '1')
  const seconds = Number(values.get('seconds') ?? '60')

  if (!Number.isInteger(players) || players < 1) throw new Error('--players is a whole number from 1')
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds is a number of seconds')

  return { players, seconds, url: values.get('url') ?? 'http://localhost:8788' }
}

/** Runs a crowd of fresh wallets against a server that is already up. */
export async function runCrowd(line: CommandLine, log: (line: string) => void): Promise<void> {
  log(`${line.players} bot(s) playing ${line.url} for ${line.seconds}s`)

  const played = await Promise.all(
    Array.from({ length: line.players }, () =>
      runBot({ baseUrl: line.url, keyPair: KeyPair.generate(), seconds: line.seconds, log }),
    ),
  )

  for (const quests of played) {
    const summary = quests.map((quest) => `${quest.kind} ${quest.progress}/${quest.target} ${quest.state}`)
    log(summary.join(', '))
  }
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  await runCrowd(readArguments(process.argv.slice(2)), (line) => console.log(line))
  process.exit(0)
}
