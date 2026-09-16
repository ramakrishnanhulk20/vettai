import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QuestView } from '../domain/quests.js'
import { LUNA_PER_NIM, lunaToNim } from '../lib/luna.js'
import { sleep } from '../lib/sleep.js'

/**
 * The prove-it command.
 *
 * It starts the real world in this process, plays it with a scripted wallet through the
 * real socket, and then attacks it: forged signatures, replays, somebody else's quest,
 * three caps, a short shop payment, a flood on the socket, and a payout the treasury has
 * already sent once. Every refusal is printed with the reason the server gave. Testnet
 * only, because it moves real test NIM out of a real wallet.
 *
 * The caps are turned down for this run so all three can be crossed inside one pass.
 * Everything else is the code that is deployed.
 */

const TOTAL_CHECKS = 12

/**
 * The caps this run uses instead of the ones in .env. A pool of 100 NIM cannot be proven
 * without spending 100 NIM, so it is turned down to something a single run can reach.
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
}

/** One line a person can read: the number, the verdict, what was tried, and what happened. */
export function formatCheck(line: CheckLine, total: number = TOTAL_CHECKS): string {
  const counter = `${String(line.number).padStart(2, ' ')}/${total}`
  return `${counter}  ${line.ok ? 'PASS' : 'FAIL'}  ${line.title}: ${line.reason}`
}

/** The name of the file this run is written to, one per minute, sortable by name. */
export function proofFileName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-')
  return `prove-${stamp}.txt`
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const here = dirname(fileURLToPath(import.meta.url))
const proofsFolder = resolve(here, '../../../../docs/proofs')

/** What the checks need on chain, in luna, before the run is worth starting. */
const MINIMUM_TREASURY_LUNA = 5n * LUNA_PER_NIM

/** What the treasury lends wallet A so it can pay for its own gear. */
const SHOP_FUNDING_LUNA = 150_000n

/** A deliberately short payment, enough to exist on chain and nowhere near a price. */
const SHORT_PAYMENT_LUNA = 1_000n

const HUNT_SECONDS = 240
const LANDMARK_SECONDS = 300

async function main(): Promise<number> {
  const started = new Date()
  const lines: string[] = []
  const results: CheckLine[] = []

  function say(line: string): void {
    lines.push(line)
    console.log(line)
  }

  const { config, dailyCapLuna, poolTotalLuna, treasuryKeyFromEnvFiles } = await import('../config.js')
  const treasuryKey = treasuryKeyFromEnvFiles()

  if (config.NIMIQ_NETWORK !== 'TestAlbatross') {
    say(`refusing to run: NIMIQ_NETWORK is ${config.NIMIQ_NETWORK} and this command only runs on TestAlbatross`)
    return 1
  }
  if (!treasuryKey) {
    say('refusing to run: TREASURY_PRIVATE_KEY is not in .env.treasury, so nothing can be paid')
    return 1
  }

  const { and, asc, eq } = await import('drizzle-orm')
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
  const { httpJson, openWorldSocket, scriptedWallet, signIn, startWorld } = await import('./support.js')

  const nim = (luna: bigint): string => `${lunaToNim(luna)} NIM`

  const handle = await openMemoryDb()
  await applyMigrations(handle)
  const db = handle.db

  const world = await startWorld({ db })
  const base = world.url

  const treasury = createSender({
    privateKeyHex: treasuryKey,
    network: config.NIMIQ_NETWORK,
    rpc,
  })

  say(`vettai prove-it, ${started.toISOString()}`)
  say(`world ${base}, database pglite in memory, node ${config.NIMIQ_RPC_URL}`)
  say(
    `caps for this run: daily ${nim(dailyCapLuna)}, pool ${nim(poolTotalLuna)}, ` +
      `${config.IP_WALLETS_PER_DAY} wallets per IP per day`,
  )
  say('')

  function record(number: number, title: string, ok: boolean, reason: string): void {
    const line: CheckLine = { number, title, ok, reason }
    results.push(line)
    say(formatCheck(line))
  }

  // A node on the wrong chain or a treasury that cannot be identified means nothing below
  // is safe to try, so the run stops rather than spending anything to find that out again.
  let halted = false

  async function check(number: number, title: string, body: () => Promise<string>): Promise<boolean> {
    if (halted) {
      record(number, title, false, 'not run, because check 1 could not identify the node or the treasury')
      return false
    }

    try {
      record(number, title, true, await body())
      return true
    } catch (error) {
      record(number, title, false, reasonOf(error))
      return false
    }
  }

  function demand(ok: boolean, complaint: string): void {
    if (!ok) throw new Error(complaint)
  }

  type Wallet = ReturnType<typeof scriptedWallet>
  type Session = { wallet: Wallet; token: string; address: string; ip: string }

  async function newPlayer(ip = '127.0.0.1'): Promise<Session> {
    const wallet = scriptedWallet()
    const session = await signIn(base, wallet, ip)
    return { wallet, token: session.token, address: session.address, ip }
  }

  async function questsOf(player: Session): Promise<QuestView[]> {
    const today = await httpJson<{ quests: QuestView[] }>(base, '/api/quests/today', {
      token: player.token,
      localAddress: player.ip,
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

  async function claimQuest(player: Session, questId: string): Promise<ClaimAnswer> {
    const challenge = await httpJson<{ message: string; error?: string }>(
      base,
      `/api/quests/${questId}/claim/challenge`,
      { method: 'POST', body: {}, token: player.token, localAddress: player.ip },
    )
    if (challenge.status !== 200) {
      return { status: challenge.status, ...(challenge.body.error ? { error: challenge.body.error } : {}) }
    }

    const signed = signWithKeyPair(player.wallet.keyPair, challenge.body.message)
    const sent = await httpJson<ClaimAnswer>(base, `/api/quests/${questId}/claim`, {
      method: 'POST',
      body: {
        message: challenge.body.message,
        publicKey: signed.publicKeyHex,
        signature: signed.signatureHex,
      },
      token: player.token,
      localAddress: player.ip,
    })

    return { ...sent.body, status: sent.status }
  }

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
  let replayable: Awaited<ReturnType<typeof signIn>> | null = null
  let walletB: Session | null = null
  let huntQuestId = ''
  let huntClaimId = ''
  let huntRewardLuna = 0n

  const identified = await check(1, 'the node and the treasury are the ones we say they are', async () => {
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
  })

  halted = !identified

  await check(2, 'a wallet signs in and the server reads its address off the key', async () => {
    const wallet = scriptedWallet()
    const session = await signIn(base, wallet, '127.0.0.1')
    walletA = { wallet, token: session.token, address: session.address, ip: '127.0.0.1' }

    demand(
      session.address === wallet.address,
      `the server said ${session.address} and the key derives ${wallet.address}`,
    )

    const me = await httpJson<{ address: string }>(base, '/api/me', { token: session.token })
    demand(me.status === 200, `/api/me answered ${me.status}`)
    demand(me.body.address === wallet.address, `/api/me said ${me.body.address}`)

    // The replayed login below needs the exact bytes this sign-in used.
    replayable = session
    return `${wallet.address} signed in, /api/me agrees, nothing named an address but the key`
  })

  await check(3, 'a forged signature and a replayed challenge are both refused', async () => {
    const holder = walletA
    demand(holder !== null, 'wallet A never signed in')
    if (!holder) throw new Error('wallet A never signed in')

    const challenge = await httpJson<{ message: string }>(base, '/api/auth/challenge', {
      method: 'POST',
      body: {},
    })
    const imposter = scriptedWallet()
    const wrong = signWithKeyPair(imposter.keyPair, challenge.body.message)

    const forged = await httpJson<{ error: string }>(base, '/api/auth/verify', {
      method: 'POST',
      body: {
        message: challenge.body.message,
        publicKey: holder.wallet.keyPair.publicKey.toHex(),
        signature: wrong.signatureHex,
      },
    })
    demand(forged.status === 401, `a forged signature was answered with ${forged.status}`)

    const used = replayable
    demand(used !== null, 'there is nothing to replay')
    if (!used) throw new Error('there is nothing to replay')

    const replay = await httpJson<{ error: string }>(base, '/api/auth/verify', {
      method: 'POST',
      body: { message: used.message, publicKey: used.publicKey, signature: used.signature },
    })
    demand(replay.status === 401, `a replayed login was answered with ${replay.status}`)

    return `forged signature 401 "${forged.body.error}", replayed challenge 401 "${replay.body.error}"`
  })

  await check(4, 'a scripted wallet plays the real world until the hunt quest is done', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const from = Date.now()
    const rows = await runBot({
      baseUrl: base,
      keyPair: player.wallet.keyPair,
      seconds: HUNT_SECONDS,
      until: (quests) => (quests.find((quest) => quest.kind === 'hunt')?.progress ?? 0) >= 5,
    })
    const seconds = Math.round((Date.now() - from) / 1000)

    const hunt = questNamed(rows, 'hunt')
    huntQuestId = hunt.id
    huntRewardLuna = BigInt(hunt.rewardLuna)

    demand(hunt.progress >= 5, `only ${hunt.progress} kills in ${seconds}s`)
    demand(hunt.state === 'done', `the hunt is ${hunt.state}, not done`)

    return `${hunt.progress} kills in ${seconds}s through the socket, reward ${nim(huntRewardLuna)}`
  })

  await check(5, 'the hunt claim is signed once, and a replay or another wallet is refused', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const challenge = await httpJson<{ message: string }>(
      base,
      `/api/quests/${huntQuestId}/claim/challenge`,
      { method: 'POST', body: {}, token: player.token, localAddress: player.ip },
    )
    demand(challenge.status === 200, `the claim challenge answered ${challenge.status}`)

    const signed = signWithKeyPair(player.wallet.keyPair, challenge.body.message)
    const body = {
      message: challenge.body.message,
      publicKey: signed.publicKeyHex,
      signature: signed.signatureHex,
    }

    const first = await httpJson<ClaimAnswer>(base, `/api/quests/${huntQuestId}/claim`, {
      method: 'POST',
      body,
      token: player.token,
      localAddress: player.ip,
    })
    demand(first.status === 200, `the claim answered ${first.status}: ${first.raw}`)
    demand(first.body.state === 'queued', `the claim came back ${String(first.body.state)}`)
    demand(
      /^vettai:[0-9a-f]{8}$/.test(first.body.memo ?? ''),
      `the memo is "${String(first.body.memo)}"`,
    )
    huntClaimId = first.body.claimId ?? ''

    const replay = await httpJson<ClaimAnswer>(base, `/api/quests/${huntQuestId}/claim`, {
      method: 'POST',
      body,
      token: player.token,
      localAddress: player.ip,
    })
    demand(replay.status === 409, `the replayed claim answered ${replay.status}`)

    walletB = await newPlayer('127.0.0.1')
    const thief = await claimQuest(walletB, huntQuestId)
    demand(thief.status === 404, `wallet B claiming wallet A's quest answered ${thief.status}`)

    return `queued with memo ${String(first.body.memo)}, replay 409 "${String(replay.body.error)}", another wallet 404`
  })

  await check(6, 'the treasury pays it on chain and the payment carries the quest id', async () => {
    const summary = await deliverOnce(db, treasury, new Date(), { log: (line) => say(`     ${line}`) })
    demand(summary.sent >= 1, `the outbox sent ${summary.sent} payouts`)

    const row = await claimRow(huntClaimId)
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

  await check(7, 'the daily cap holds the claim that would cross it', async () => {
    const player = walletA
    if (!player) throw new Error('wallet A never signed in')

    const rows = await runBot({
      baseUrl: base,
      keyPair: player.wallet.keyPair,
      seconds: LANDMARK_SECONDS,
      until: (quests) => quests.find((quest) => quest.kind === 'landmarks')?.state !== 'open',
    })

    const landmarks = questNamed(rows, 'landmarks')
    demand(landmarks.state === 'done', `the landmarks quest is ${landmarks.state} after the walk`)

    const before = await committedTotals(player.address)

    const held = await claimQuest(player, landmarks.id)
    demand(held.status === 200, `the landmarks claim answered ${held.status}`)
    demand(held.state === 'held', `the landmarks claim came back ${String(held.state)}`)
    demand(held.reason === 'daily cap', `it was held for "${String(held.reason)}"`)

    const streak = questNamed(rows, 'streak')
    const alsoHeld = await claimQuest(player, streak.id)
    demand(alsoHeld.state === 'held', `the streak claim came back ${String(alsoHeld.state)}`)
    demand(alsoHeld.reason === 'daily cap', `the streak claim was held for "${String(alsoHeld.reason)}"`)

    return (
      `${nim(before.today)} already committed today, ${nim(BigInt(landmarks.rewardLuna))} more crosses ` +
      `the ${nim(dailyCapLuna)} cap, landmarks and streak both held for "daily cap"`
    )
  })

  await check(8, 'the third wallet claiming from one address is held', async () => {
    const second = walletB
    if (!second) throw new Error('wallet B never signed in')

    const bQuests = await questsOf(second)
    const bStreak = questNamed(bQuests, 'streak')
    const bClaim = await claimQuest(second, bStreak.id)
    demand(bClaim.state === 'queued', `the second wallet came back ${String(bClaim.state)}`)

    const third = await newPlayer('127.0.0.1')
    const seenBefore = await walletsFromIp(third.ip, third.address)
    const cStreak = questNamed(await questsOf(third), 'streak')
    const cClaim = await claimQuest(third, cStreak.id)

    const fourth = await newPlayer('127.0.0.1')
    const dStreak = questNamed(await questsOf(fourth), 'streak')
    const dClaim = await claimQuest(fourth, dStreak.id)

    demand(seenBefore === config.IP_WALLETS_PER_DAY, `${seenBefore} wallets had claimed from this address`)
    demand(cClaim.state === 'held', `the third wallet came back ${String(cClaim.state)}`)
    demand(cClaim.reason === 'ip cap', `the third wallet was held for "${String(cClaim.reason)}"`)
    demand(dClaim.reason === 'ip cap', `the fourth wallet was held for "${String(dClaim.reason)}"`)

    return (
      `wallets 1 and 2 from 127.0.0.1 were queued, ${seenBefore} distinct wallets had claimed, ` +
      `wallets 3 and 4 held for "ip cap"`
    )
  })

  await check(9, 'the pool stops the claim that would spend past it', async () => {
    const totals: string[] = []
    let crossed: ClaimAnswer | null = null
    let crossingAmount = 0n

    // The per-IP rule would refuse a third wallet from one address before the pool was ever
    // reached, so these wallets come in from their own loopback addresses. That is the same
    // thing a farmer with a VPN does, which the threat model says plainly.
    for (const ip of ['127.0.0.2', '127.0.0.2', '127.0.0.3']) {
      const player = await newPlayer(ip)
      const streak = questNamed(await questsOf(player), 'streak')
      const before = await committedTotals(player.address)
      const amount = BigInt(streak.rewardLuna)

      const answer = await claimQuest(player, streak.id)
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

  await check(10, 'a real shop payment grants the gear and a short one from another wallet does not', async () => {
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

    const order = await httpJson<{ orderId: string; memo: string; luna: string; to: string }>(
      base,
      '/api/shop/orders',
      { method: 'POST', body: { item: 'blaster-mk2' }, token: buyer.token, localAddress: buyer.ip },
    )
    demand(order.status === 200, `the order answered ${order.status}: ${order.raw}`)

    const decoy = await httpJson<{ orderId: string; memo: string }>(base, '/api/shop/orders', {
      method: 'POST',
      body: { item: 'blaster-mk2' },
      token: other.token,
      localAddress: other.ip,
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

    const pass = await watcher.tick(db, rpc, { log: (line) => say(`     ${line}`) })
    demand(pass.paid === 1, `the watcher settled ${pass.paid} orders in one pass`)

    const view = await httpJson<{ state: string }>(base, `/api/shop/orders/${order.body.orderId}`, {
      token: buyer.token,
      localAddress: buyer.ip,
    })
    demand(view.body.state === 'paid', `the order is ${view.body.state}`)

    const me = await httpJson<{ gear: { blaster: string } }>(base, '/api/me', { token: buyer.token })
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
  })

  await check(11, 'the socket refuses a flood, a long move vector and nonsense frames', async () => {
    // A wallet of its own, carrying the stock mk1 blaster. Wallet A bought the mk2 two
    // checks ago and that raises its own fire rate to six, which would make the four below
    // the wrong bar to hold the server to.
    const player = await newPlayer('127.0.0.1')

    const ticket = await httpJson<{ ticket: string }>(base, '/api/world/ticket', { token: player.token })
    const socket = await openWorldSocket(`${base.replace('http', 'ws')}/ws?ticket=${ticket.body.ticket}`)
    await socket.waitForKind('welcome')

    const room = world.rooms.roomFor(player.address)
    demand(room !== null, 'the player is in no room')
    const positionAt = (): { x: number; z: number } => {
      const live = world.rooms.roomFor(player.address)?.state.players.get(player.address)
      if (!live) throw new Error('the player left the world')
      return { x: live.x, z: live.z }
    }

    const droppedBefore = world.rooms.dropped(player.address) ?? 0
    const from = positionAt()
    for (let n = 0; n < 30; n += 1) socket.send({ t: 'move', dx: 0, dz: 1, yaw: 0 })
    await sleep(1000)
    const to = positionAt()
    const walked = Math.hypot(to.x - from.x, to.z - from.z)
    const droppedMoves = (world.rooms.dropped(player.address) ?? 0) - droppedBefore

    demand(walked <= 7, `the player covered ${walked.toFixed(2)} m in a second`)
    demand(droppedMoves >= 10, `only ${droppedMoves} of the 30 moves were dropped`)

    await sleep(1100)
    socket.send({ t: 'move', dx: 50, dz: 0, yaw: 0 })
    await sleep(250)
    const intent = world.rooms.roomFor(player.address)?.state.players.get(player.address)?.intent
    demand(intent !== undefined, 'the player has no intent')
    const length = Math.hypot(intent?.dx ?? 0, intent?.dz ?? 0)
    demand(Math.abs(length - 1) < 1e-6, `a dx of 50 was stored as a vector of length ${length}`)

    await sleep(1100)
    for (let n = 0; n < 20; n += 1) socket.send({ t: 'fire', yaw: 0, pitch: 0 })
    await sleep(300)
    const shooter = world.rooms.roomFor(player.address)?.state.players.get(player.address)
    const accepted = (shooter?.recentFires ?? []).filter((at) => at > Date.now() - 1000).length
    demand(accepted <= 4, `${accepted} shots were accepted in one second`)
    socket.close()

    const second = await httpJson<{ ticket: string }>(base, '/api/world/ticket', { token: player.token })
    const rude = await openWorldSocket(`${base.replace('http', 'ws')}/ws?ticket=${second.body.ticket}`)
    await rude.waitForKind('welcome')
    rude.sendRaw('not json at all')
    rude.sendRaw('{"v":1}')
    rude.sendRaw('{"v":1,"t":"teleport"}')
    const closed = await rude.waitForClose(5000)
    demand(closed.code === 1008, `the socket closed with ${closed.code}`)

    return (
      `30 moves in a second: ${droppedMoves} dropped and ${walked.toFixed(2)} m covered, under the 6 m/s cap; ` +
      `dx 50 stored as a unit vector; 20 fire frames gave ${accepted} accepted shots on an mk1; ` +
      `three bad frames closed the socket with ${closed.code}`
    )
  })

  await check(12, 'a payout that already has a hash is looked up, never sent again', async () => {
    const queued = await db.select().from(claims).where(eq(claims.state, 'queued')).orderBy(asc(claims.createdAt))
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

    const summary = await deliverOnce(db, treasury, new Date(), { log: (line) => say(`     ${line}`) })

    // Anything broadcast but not yet in a block is settled by a second pass, which has no
    // queued rows left to send, so the balance below is measured against a finished ledger.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const waiting = await db.select().from(claims).where(eq(claims.state, 'sent'))
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

    let expected = 0n
    for (const row of stillQueued) expected += (await claimRow(row.id)).state === 'paid' ? row.amountLuna : 0n

    demand(spent === expected, `the treasury fell by ${nim(spent)} against ${nim(expected)} of confirmed payouts`)

    return (
      `${summary.sent} payout(s) left in this pass; the claim holding a made up hash stayed "sending" and was ` +
      `not signed again; the treasury fell by ${nim(spent)}, exactly the confirmed payouts of this pass`
    )
  })

  const passed = results.filter((line) => line.ok).length

  say('')
  say(`${passed}/${TOTAL_CHECKS} passed`)
  for (const line of results.filter((row) => !row.ok)) say(`  still failing: ${formatCheck(line)}`)

  const finalBalance = BigInt((await rpc.getAccountByAddress(config.TREASURY_ADDRESS)).balance)
  say(`treasury ${config.TREASURY_ADDRESS} now holds ${nim(finalBalance)}`)
  say(`finished in ${Math.round((Date.now() - started.getTime()) / 1000)}s`)

  await mkdir(proofsFolder, { recursive: true })
  const file = resolve(proofsFolder, proofFileName(started))
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  console.log(`written to ${file}`)

  await world.stop()
  await handle.close()

  return passed === TOTAL_CHECKS ? 0 : 1
}

const runAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (runAsScript) {
  // The caps have to be in the environment before config.ts reads it, so everything that
  // can reach config.ts is loaded inside main. dotenv leaves a key that is already set alone.
  for (const [key, value] of Object.entries(CAP_OVERRIDES)) process.env[key] = value

  process.exit(await main())
}
