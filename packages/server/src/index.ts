import { networkInterfaces } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { config, worldBootRefusal } from './config.js'
import { openDb } from './db/client.js'
import { applyMigrations } from './db/migrate.js'
import { worldMap } from './routes/world.js'
import { startGearSweep } from './world/gear.js'
import { createRooms, recordWorldEvents, ROOM_CAPACITY, TICK_MS } from './world/rooms.js'

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
}

const refusal = worldBootRefusal(config, process.env)
if (refusal) {
  console.error(`the vettai world will not start: ${refusal}`)
  process.exit(1)
}

const handle = await openDb()
const migrations = await applyMigrations(handle)

const map = worldMap()

let server: FastifyInstance | null = null

function logLine(line: string, detail: Record<string, unknown> = {}): void {
  server?.log.info(detail, line)
}

const rooms = createRooms({
  map,
  seed: config.MAP_SEED,
  capacity: ROOM_CAPACITY,
  tickMs: TICK_MS,
  // The recorder needs the rooms, to push a finished quest back to its player, and the
  // rooms need the recorder, to be told what happened. The world only starts ticking
  // further down, by which point both of them exist.
  onEvents: (events) => record(events),
  log: logLine,
})

const record = recordWorldEvents(handle.db, rooms, { log: logLine })

// The treasury settles a shop payment in the database; this is what turns it into gear in
// the hands of a player who is standing in the world right now.
const gear = startGearSweep({ db: handle.db, rooms, log: logLine })

const app = await buildApp({ db: handle.db, world: { map, rooms } })
server = app

for (const name of migrations.applied) app.log.info(`applied migration ${name}`)

let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true

  app.log.info({ signal }, 'shutting the world down')
  gear.stop()
  rooms.stop()
  await app.close()
  await handle.close()
  process.exit(0)
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}

try {
  rooms.start()
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
  app.log.info(
    {
      network: config.NIMIQ_NETWORK,
      database: handle.kind,
      map: config.MAP_SEED,
      mapVersion: map.version,
    },
    'vettai world ready',
  )
  for (const ip of lanAddresses()) {
    app.log.info(`open on the phone: http://${ip}:${config.PORT}`)
  }
} catch (error) {
  app.log.error({ err: error }, 'failed to start')
  gear.stop()
  rooms.stop()
  process.exit(1)
}
