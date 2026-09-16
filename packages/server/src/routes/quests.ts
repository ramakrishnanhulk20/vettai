import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { quests, type Quest } from '../db/schema.js'
import {
  consumeChallenge,
  issueChallenge,
  parseChallengeMessage,
} from '../domain/challenges.js'
import { claimMemo, listClaims, queueClaimIn, type ClaimKind } from '../domain/claims.js'
import { questView, todaysQuests } from '../domain/quests.js'
import { utcDay } from '../lib/day.js'
import { lunaToNim } from '../lib/luna.js'
import { verifySignedMessage } from '../nimiq/verify.js'
import { currentPlayer, firstIssue, ipHash, type RouteDeps } from './context.js'
import type { WorldDeps } from './world.js'

const questId = z.object({ id: z.uuid() })

const claimBody = z.object({
  message: z.string().min(1).max(200),
  publicKey: z.string().min(1).max(200),
  signature: z.string().min(1).max(300),
})

async function ownedQuest(deps: RouteDeps, id: string, address: string): Promise<Quest | null> {
  const [row] = await deps.db
    .select()
    .from(quests)
    .where(and(eq(quests.id, id), eq(quests.address, address)))
    .limit(1)

  return row ?? null
}

export function registerQuestRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  world: WorldDeps,
): void {
  app.get('/api/quests/today', { preHandler: deps.requireSession }, async (request, reply) => {
    const { address } = currentPlayer(request)
    const now = new Date()
    const rows = await todaysQuests(deps.db, address, world.map, now)

    return reply.send({ day: utcDay(now), quests: rows.map(questView) })
  })

  app.post(
    '/api/quests/:id/claim/challenge',
    { preHandler: deps.requireSession },
    async (request, reply) => {
      const params = questId.safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: firstIssue(params.error) })

      const { address } = currentPlayer(request)
      const quest = await ownedQuest(deps, params.data.id, address)

      // A quest belonging to somebody else reads as missing on purpose: answering
      // "not yours" would tell a caller which quest ids are real.
      if (!quest) return reply.code(404).send({ error: 'no such quest' })
      if (quest.state === 'claimed') return reply.code(409).send({ error: 'already claimed' })
      if (quest.state !== 'done') return reply.code(409).send({ error: 'that quest is not done yet' })

      const challenge = await issueChallenge(deps.db, 'claim', quest.id)
      return reply.send({
        message: challenge.message,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
      })
    },
  )

  /**
   * The one door to a payout.
   *
   * The signature is checked first and the address is read off the public key, so a caller
   * cannot claim for a wallet it does not hold. The nonce is spent next, which is what
   * stops the same signed message being sent twice. The claim row and the quest going to
   * `claimed` are then one transaction: either a player has a payout and a spent quest, or
   * neither, never a quest marked claimed with no money behind it. Inside that transaction
   * the unique index on quest_id is the real lock, so two requests that both get this far
   * end with one payout and one refusal.
   */
  app.post('/api/quests/:id/claim', { preHandler: deps.requireSession }, async (request, reply) => {
    const params = questId.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: firstIssue(params.error) })

    const body = claimBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: firstIssue(body.error) })

    const { address } = currentPlayer(request)
    const quest = await ownedQuest(deps, params.data.id, address)
    if (!quest) return reply.code(404).send({ error: 'no such quest' })
    if (quest.state === 'claimed') return reply.code(409).send({ error: 'already claimed' })
    if (quest.state !== 'done') return reply.code(409).send({ error: 'that quest is not done yet' })

    const parsed = parseChallengeMessage(body.data.message)
    if (!parsed || parsed.kind !== 'claim' || parsed.subject !== quest.id) {
      return reply.code(400).send({ error: 'message is not a claim challenge for this quest' })
    }

    const verified = verifySignedMessage({
      message: body.data.message,
      publicKeyHex: body.data.publicKey,
      signatureHex: body.data.signature,
    })
    if (!verified.ok) {
      request.log.warn({ ip: request.ip, reason: verified.reason }, 'claim refused')
      return reply.code(401).send({ error: verified.reason })
    }
    if (verified.address !== address) {
      request.log.warn({ ip: request.ip, address }, 'claim refused: signed by another wallet')
      return reply.code(401).send({ error: 'that signature is from another wallet' })
    }

    // A quest worth nothing has nothing to claim. Saying so before the nonce is spent
    // leaves the player's challenge usable, and keeps a zero out of the claims table.
    if (quest.rewardLuna <= 0n) {
      return reply.code(400).send({ error: 'nothing to claim' })
    }

    const spent = await consumeChallenge(deps.db, body.data.message)
    if (!spent.ok) {
      request.log.warn({ ip: request.ip, reason: spent.reason }, 'claim refused')
      return reply.code(401).send({ error: spent.reason })
    }

    const result = await deps.db.transaction(async (tx) => {
      const queued = await queueClaimIn(tx, {
        address,
        questId: quest.id,
        kind: quest.kind as ClaimKind,
        amountLuna: quest.rewardLuna,
        ipHash: ipHash(request),
      })

      // A refusal means this quest already has a claim, so the quest is left exactly as it
      // was found and the caller is told about the claim that exists.
      if (queued.state !== 'refused') {
        await tx
          .update(quests)
          .set({ state: 'claimed' })
          .where(and(eq(quests.id, quest.id), eq(quests.state, 'done')))
      }

      return queued
    })

    if (result.state === 'refused') {
      return reply.code(409).send({ error: 'already claimed', claimId: result.claimId })
    }

    request.log.info(
      { address, quest: quest.id, state: result.state, amount: String(quest.rewardLuna) },
      'claim queued',
    )

    return reply.send({
      state: result.state,
      claimId: result.claimId,
      memo: claimMemo(quest.id),
      amountLuna: String(quest.rewardLuna),
      amountNim: lunaToNim(quest.rewardLuna),
      ...(result.state === 'held' ? { reason: result.reason } : {}),
    })
  })

  app.get('/api/claims', { preHandler: deps.requireSession }, async (request, reply) => {
    const { address } = currentPlayer(request)
    const rows = await listClaims(deps.db, address)

    return reply.send({
      claims: rows.map((claim) => ({
        id: claim.id,
        questId: claim.questId,
        kind: claim.kind,
        state: claim.state,
        amountLuna: String(claim.amountLuna),
        amountNim: lunaToNim(claim.amountLuna),
        memo: claim.memo,
        txHash: claim.txHash,
        blockNumber: claim.blockNumber,
        createdAt: claim.createdAt,
        paidAt: claim.paidAt,
        error: claim.error,
      })),
    })
  })
}
