// Covers reading a wallet's stake and finishing the landlord quest with it. It does NOT
// cover the real staking RPC (the shape of the record here is copied from a live mainnet
// read on 15 September 2026), and it does NOT cover the daily timer in the treasury.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { Db, DbHandle } from '../src/db/client.js'
import { players, quests } from '../src/db/schema.js'
import { completeLandlordQuests, readStakeLuna, shouldReadStakes } from '../src/treasury/stakes.js'
import { nimToLuna } from '../src/lib/luna.js'
import { clearTables, freshDb, insertPlayer } from './support/db.js'
import { FakeRpc } from './support/fakeRpc.js'

const NOW = new Date('2026-09-15T10:00:00Z')
const TEN_NIM = nimToLuna('10')

let handle: DbHandle
let db: Db
let rpc: FakeRpc

beforeAll(async () => {
  handle = await freshDb()
  db = handle.db
}, 60_000)

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await clearTables(db)
  rpc = new FakeRpc()
})

async function landlordQuest(stakeLuna: bigint | null, day = '2026-09-15'): Promise<string> {
  const { address } = await insertPlayer(db)
  if (stakeLuna !== null) rpc.stakes.set(address, stakeLuna)

  await db.insert(quests).values({
    address,
    day,
    kind: 'landlord',
    target: 1,
    rewardLuna: nimToLuna('0.2'),
  })

  return address
}

function options() {
  return { staggerMs: 0, minStakeLuna: TEN_NIM, log: () => {} }
}

describe('readStakeLuna', () => {
  it('reads an active stake in luna and a wallet that never staked as zero', async () => {
    const staker = await landlordQuest(TEN_NIM)

    expect(await readStakeLuna(rpc, staker)).toBe(TEN_NIM)
    expect(await readStakeLuna(rpc, (await insertPlayer(db)).address)).toBe(0n)
  })
})

describe('completeLandlordQuests', () => {
  it('finishes the quest for a wallet that stakes enough and leaves the others open', async () => {
    const enough = await landlordQuest(TEN_NIM)
    const notEnough = await landlordQuest(nimToLuna('9.99999'))
    const never = await landlordQuest(null)

    const summary = await completeLandlordQuests(db, rpc, NOW, options())

    expect(summary).toMatchObject({ checked: 3, completed: 1, failed: 0 })

    const states = new Map<string, string>()
    for (const row of await db.select().from(quests)) states.set(row.address, row.state)

    expect(states.get(enough)).toBe('done')
    expect(states.get(notEnough)).toBe('open')
    expect(states.get(never)).toBe('open')

    const [player] = await db.select().from(players).where(eq(players.address, enough))
    expect(player?.landlordSince?.toISOString()).toBe(NOW.toISOString())
  })

  it('finishes a quest once and leaves a claimed one alone', async () => {
    const address = await landlordQuest(TEN_NIM)

    await completeLandlordQuests(db, rpc, NOW, options())
    await db
      .update(quests)
      .set({ state: 'claimed' })
      .where(and(eq(quests.address, address), eq(quests.kind, 'landlord')))

    const second = await completeLandlordQuests(db, rpc, new Date(NOW.getTime() + 86_400_000), options())

    expect(second).toMatchObject({ checked: 0, completed: 0 })

    const [row] = await db.select().from(quests).where(eq(quests.address, address))
    expect(row?.state).toBe('claimed')
  })

  it('finishes only the quest of the day it is run for', async () => {
    const { address } = await insertPlayer(db)
    rpc.stakes.set(address, TEN_NIM)

    for (const day of ['2026-09-14', '2026-09-15']) {
      await db.insert(quests).values({
        address,
        day,
        kind: 'landlord',
        target: 1,
        rewardLuna: nimToLuna('0.2'),
      })
    }

    const summary = await completeLandlordQuests(db, rpc, NOW, options())

    expect(summary).toMatchObject({ checked: 1, completed: 1, failed: 0 })

    const states = new Map<string, string>()
    for (const row of await db.select().from(quests)) states.set(row.day, row.state)

    expect(states.get('2026-09-15')).toBe('done')
    expect(states.get('2026-09-14')).toBe('open')
  })

  it('is due once a UTC day, whatever the process has been doing', () => {
    expect(shouldReadStakes(null, NOW)).toBe(true)
    expect(shouldReadStakes('2026-09-15', NOW)).toBe(false)
    expect(shouldReadStakes('2026-09-15', new Date('2026-09-15T23:59:59Z'))).toBe(false)
    expect(shouldReadStakes('2026-09-15', new Date('2026-09-16T00:00:01Z'))).toBe(true)
  })

  it('leaves a quest open when the node cannot answer, instead of guessing', async () => {
    const address = await landlordQuest(TEN_NIM)
    rpc.getStakerByAddress = async () => {
      throw new Error('node is busy')
    }

    const summary = await completeLandlordQuests(db, rpc, NOW, options())

    expect(summary).toMatchObject({ checked: 0, completed: 0, failed: 1 })

    const [row] = await db.select().from(quests).where(eq(quests.address, address))
    expect(row?.state).toBe('open')
  })
})
