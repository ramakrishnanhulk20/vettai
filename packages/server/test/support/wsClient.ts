import { WebSocket } from 'ws'

/**
 * A small real WebSocket client for the tests. It buffers every frame the server sends and
 * lets a test wait for the next one that matters, so a test reads as a list of steps rather
 * than a pile of callbacks.
 */

export type Frame = Record<string, unknown> & { t: string }

export type Closed = { code: number; reason: string }

export type TickEvent = Record<string, unknown> & { kind: string }

function tickEvents(frame: Frame): TickEvent[] {
  return frame.t === 'state' ? ((frame['events'] as TickEvent[] | undefined) ?? []) : []
}

export type TestClient = {
  socket: WebSocket
  frames: Frame[]
  send: (payload: Record<string, unknown>) => void
  sendRaw: (text: string) => void
  /** The next frame, from where the last wait stopped, that the predicate accepts. */
  waitFor: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>
  waitForKind: (kind: string, timeoutMs?: number) => Promise<Frame>
  waitForEvent: (eventKind: string, timeoutMs?: number) => Promise<Frame>
  /** The events on the next state frame carrying one of this kind. The simulation's own events ride there. */
  waitForTickEvents: (eventKind: string, timeoutMs?: number) => Promise<TickEvent[]>
  waitForClose: (timeoutMs?: number) => Promise<Closed>
  seenEvent: (eventKind: string) => boolean
  seenTickEvent: (eventKind: string) => boolean
  close: () => void
}

const DEFAULT_TIMEOUT_MS = 5000

/**
 * Opens the socket and settles when the server has either accepted the upgrade or refused
 * it. A refusal is an error carrying the HTTP status, which is how a test proves a bad
 * ticket never becomes a connection at all.
 */
export function openSocket(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const frames: Frame[] = []
    const waiting: (() => void)[] = []
    let closed: Closed | null = null
    let cursor = 0

    function wake(): void {
      while (waiting.length > 0) waiting.pop()?.()
    }

    socket.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as Frame)
      wake()
    })

    socket.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() }
      wake()
    })

    socket.on('unexpected-response', (_request, response) => {
      reject(new Error(`the upgrade was refused with ${response.statusCode}`))
    })

    socket.on('error', (error) => {
      reject(error)
    })

    function settled(): Promise<void> {
      return new Promise((wakeUp) => {
        const timer = setTimeout(wakeUp, 20)
        waiting.push(() => {
          clearTimeout(timer)
          wakeUp()
        })
      })
    }

    async function waitFor(
      predicate: (frame: Frame) => boolean,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<Frame> {
      const until = Date.now() + timeoutMs
      for (;;) {
        while (cursor < frames.length) {
          const frame = frames[cursor]
          cursor += 1
          if (frame && predicate(frame)) return frame
        }
        if (Date.now() > until) throw new Error('the server never sent a frame like that')
        await settled()
      }
    }

    const client: TestClient = {
      socket,
      frames,
      send: (payload) => socket.send(JSON.stringify({ v: 1, ...payload })),
      sendRaw: (text) => socket.send(text),
      waitFor,
      waitForKind: (kind, timeoutMs) => waitFor((frame) => frame.t === kind, timeoutMs),
      waitForEvent: (eventKind, timeoutMs) =>
        waitFor((frame) => frame.t === 'event' && frame['kind'] === eventKind, timeoutMs),
      waitForTickEvents: async (eventKind, timeoutMs) =>
        tickEvents(
          await waitFor(
            (frame) => tickEvents(frame).some((event) => event.kind === eventKind),
            timeoutMs,
          ),
        ),
      waitForClose: async (timeoutMs = DEFAULT_TIMEOUT_MS) => {
        const until = Date.now() + timeoutMs
        while (!closed) {
          if (Date.now() > until) throw new Error('the socket never closed')
          await settled()
        }
        return closed
      },
      seenEvent: (eventKind) =>
        frames.some((frame) => frame.t === 'event' && frame['kind'] === eventKind),
      seenTickEvent: (eventKind) =>
        frames.some((frame) => tickEvents(frame).some((event) => event.kind === eventKind)),
      close: () => socket.close(),
    }

    socket.on('open', () => resolve(client))
  })
}
