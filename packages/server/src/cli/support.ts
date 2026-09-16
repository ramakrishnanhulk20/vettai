import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { KeyPair } from '@nimiq/core'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { config } from '../config.js'
import { canonical } from '../lib/address.js'
import type { Db } from '../db/client.js'
import { sleep } from '../lib/sleep.js'
import { signWithKeyPair } from '../nimiq/verify.js'
import { worldMap } from '../routes/world.js'
import { startGearSweep } from '../world/gear.js'
import {
  createRooms,
  recordWorldEvents,
  ROOM_CAPACITY,
  TICK_MS,
  type Rooms,
} from '../world/rooms.js'
import type { WorldMap } from '../world/types.js'

/**
 * The pieces the command line tools share: a world running inside this process, an HTTP
 * client that can pick the address it calls from, a socket client, and throwaway wallets.
 *
 * The server may not import from `test/`, so the few things the tests already do well are
 * written again here rather than reached across for.
 */

export type ScriptedWallet = {
  keyPair: KeyPair
  /** Uppercase, no spaces, which is the only form the database and the API use. */
  address: string
  privateKeyHex: string
}

/** A wallet that exists for one run of one command and is then forgotten. */
export function scriptedWallet(): ScriptedWallet {
  const keyPair = KeyPair.generate()
  return {
    keyPair,
    address: canonical(keyPair),
    privateKeyHex: keyPair.privateKey.toHex(),
  }
}

export type HttpOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  token?: string
  /**
   * The address the call is made from. Every per-IP rule in Vettai keys on the address the
   * packet came from, so proving one needs more than one source address, and the loopback
   * range gives as many as the checks need without leaving the machine.
   */
  localAddress?: string
}

export type HttpResult<T> = { status: number; body: T; raw: string }

/** One JSON call. A body that is not JSON comes back as raw text with the status intact. */
export function httpJson<T>(base: string, path: string, options: HttpOptions = {}): Promise<HttpResult<T>> {
  const url = new URL(path, base)
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body))

  const headers: Record<string, string> = { accept: 'application/json' }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.byteLength)
  }
  if (options.token) headers['authorization'] = `Bearer ${options.token}`

  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? (payload ? 'POST' : 'GET'),
        headers,
        ...(options.localAddress ? { localAddress: options.localAddress } : {}),
      },
      (response) => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          raw += chunk
        })
        response.on('end', () => {
          let body: T
          try {
            body = JSON.parse(raw) as T
          } catch {
            body = raw as unknown as T
          }
          resolve({ status: response.statusCode ?? 0, body, raw })
        })
      },
    )

    call.on('error', reject)
    if (payload) call.write(payload)
    call.end()
  })
}

/** The session, plus the exact bytes that were signed, so a caller can try replaying them. */
export type SignedIn = {
  token: string
  address: string
  message: string
  publicKey: string
  signature: string
}

/**
 * The whole sign-in a phone does: ask for a challenge, sign it the way Nimiq Pay signs,
 * send the public key and the signature back. The address is never sent; the server reads
 * it off the key, so what comes back is proof the server agreed about who this is.
 */
export async function signIn(
  base: string,
  wallet: { keyPair: KeyPair },
  localAddress?: string,
): Promise<SignedIn> {
  const challenge = await httpJson<{ message: string }>(base, '/api/auth/challenge', {
    method: 'POST',
    body: {},
    ...(localAddress ? { localAddress } : {}),
  })
  if (challenge.status !== 200) throw new Error(`the challenge was refused: ${challenge.raw}`)

  const signed = signWithKeyPair(wallet.keyPair, challenge.body.message)
  const verified = await httpJson<{ token: string; address: string }>(base, '/api/auth/verify', {
    method: 'POST',
    body: {
      message: challenge.body.message,
      publicKey: signed.publicKeyHex,
      signature: signed.signatureHex,
    },
    ...(localAddress ? { localAddress } : {}),
  })
  if (verified.status !== 200) throw new Error(`sign in failed: ${verified.raw}`)

  return {
    token: verified.body.token,
    address: verified.body.address,
    message: challenge.body.message,
    publicKey: signed.publicKeyHex,
    signature: signed.signatureHex,
  }
}

export type Frame = Record<string, unknown> & { t: string }

export type Closed = { code: number; reason: string }

export type WorldSocket = {
  send: (payload: Record<string, unknown>) => void
  sendRaw: (text: string) => void
  /** Every frame seen so far, oldest first. */
  frames: Frame[]
  /** Called for each frame as it arrives, which is how the bot keeps its picture current. */
  onFrame: (handler: (frame: Frame) => void) => void
  waitFor: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>
  waitForKind: (kind: string, timeoutMs?: number) => Promise<Frame>
  waitForClose: (timeoutMs?: number) => Promise<Closed>
  closed: () => Closed | null
  close: () => void
}

const SOCKET_TIMEOUT_MS = 10_000

/**
 * Opens the play socket and buffers what the server says, so a script reads as a list of
 * steps instead of a pile of callbacks. A refused upgrade settles as an error rather than
 * as a socket that closes a moment later.
 */
export function openWorldSocket(url: string): Promise<WorldSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const frames: Frame[] = []
    const handlers: ((frame: Frame) => void)[] = []
    const waiting: (() => void)[] = []
    let shutdown: Closed | null = null
    let open = false
    let cursor = 0

    function wake(): void {
      while (waiting.length > 0) waiting.pop()?.()
    }

    socket.addEventListener('message', (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Frame
      frames.push(frame)
      for (const handler of handlers) handler(frame)
      wake()
    })

    socket.addEventListener('close', (event: CloseEvent) => {
      shutdown = { code: event.code, reason: event.reason }
      if (!open) reject(new Error(`the socket closed before it opened: ${event.code}`))
      wake()
    })

    socket.addEventListener('error', () => {
      if (!open) reject(new Error('the world refused the socket'))
    })

    function settled(): Promise<void> {
      return new Promise((wakeUp) => {
        const timer = setTimeout(wakeUp, 10)
        waiting.push(() => {
          clearTimeout(timer)
          wakeUp()
        })
      })
    }

    async function waitFor(
      predicate: (frame: Frame) => boolean,
      timeoutMs = SOCKET_TIMEOUT_MS,
    ): Promise<Frame> {
      const until = Date.now() + timeoutMs
      for (;;) {
        while (cursor < frames.length) {
          const frame = frames[cursor]
          cursor += 1
          if (frame && predicate(frame)) return frame
        }
        if (Date.now() > until) throw new Error('the world never sent a frame like that')
        await settled()
      }
    }

    socket.addEventListener('open', () => {
      open = true
      resolve({
        frames,
        send: (payload) => socket.send(JSON.stringify({ v: 1, ...payload })),
        sendRaw: (text) => socket.send(text),
        onFrame: (handler) => handlers.push(handler),
        waitFor,
        waitForKind: (kind, timeoutMs) => waitFor((frame) => frame.t === kind, timeoutMs),
        waitForClose: async (timeoutMs = SOCKET_TIMEOUT_MS) => {
          const until = Date.now() + timeoutMs
          while (!shutdown) {
            if (Date.now() > until) throw new Error('the socket never closed')
            await sleep(20)
          }
          return shutdown
        },
        closed: () => shutdown,
        close: () => socket.close(),
      })
    })
  })
}

export type RunningWorld = {
  app: FastifyInstance
  rooms: Rooms
  map: WorldMap
  /** Where to reach it, with the port the operating system actually handed out. */
  url: string
  port: number
  stop: () => Promise<void>
}

export type StartWorldOptions = {
  db: Db
  /** Zero, the default, lets the operating system pick a free port. */
  port?: number
  host?: string
  logger?: boolean
}

/**
 * The same world `src/index.ts` runs, started inside this process on a port of its own.
 *
 * The wiring order is the part that matters and it is the order index.ts uses: the rooms
 * is built with a recorder that does not exist yet, the recorder is built with the rooms,
 * and only then does the world start ticking. Anything else leaves a tick describing events
 * to a recorder that is still undefined.
 */
export async function startWorld(options: StartWorldOptions): Promise<RunningWorld> {
  const map = worldMap()

  let recorder: ((events: Parameters<ReturnType<typeof recordWorldEvents>>[0]) => void) | null = null

  const rooms = createRooms({
    map,
    seed: config.MAP_SEED,
    capacity: ROOM_CAPACITY,
    tickMs: TICK_MS,
    onEvents: (events) => recorder?.(events),
  })

  recorder = recordWorldEvents(options.db, rooms)
  const gear = startGearSweep({ db: options.db, rooms })

  const app = await buildApp({
    db: options.db,
    logger: options.logger ?? false,
    world: { map, rooms },
    // A scripted run makes hundreds of calls a minute on purpose, so the per-IP limit is
    // lifted here. Check 11 proves the socket's own budgets, which are the ones that matter.
    rateLimit: { global: 100_000, auth: 100_000 },
  })

  rooms.start()
  await app.listen({ port: options.port ?? 0, host: options.host ?? '127.0.0.1' })

  const address = app.server.address() as AddressInfo | null
  if (!address) throw new Error('the world did not report a port')

  return {
    app,
    rooms,
    map,
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stop: async () => {
      gear.stop()
      rooms.stop()
      await app.close()
    },
  }
}
