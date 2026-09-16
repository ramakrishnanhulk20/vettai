import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { createOrder, getOrder, isShopItem, items } from '../domain/shop.js'
import { lunaToNim } from '../lib/luna.js'
import { currentPlayer, firstIssue, type RouteDeps } from './context.js'

const orderBody = z.object({ item: z.string().min(1).max(40) })

const orderId = z.object({ id: z.uuid() })

/**
 * The shop over HTTP: what is for sale, opening an order, and reading its state.
 *
 * Handing the gear over is not done here. A paid order is announced by the world's own
 * sweep (src/world/gear.ts), which reaches the player whether or not their phone happens to
 * be asking, and writes down that it did so. This route only reports.
 */
export function registerShopRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/shop', async (_request, reply) =>
    reply.send({
      to: config.TREASURY_ADDRESS,
      items: Object.values(items).map((item) => ({
        id: item.id,
        name: item.name,
        priceLuna: String(item.priceLuna),
        priceNim: lunaToNim(item.priceLuna),
        gear: item.gear,
      })),
    }),
  )

  app.post('/api/shop/orders', { preHandler: deps.requireSession }, async (request, reply) => {
    const body = orderBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: firstIssue(body.error) })
    if (!isShopItem(body.data.item)) return reply.code(400).send({ error: 'that is not in the shop' })

    const { address } = currentPlayer(request)
    const order = await createOrder(deps.db, { address, item: body.data.item })

    request.log.info({ address, order: order.id, item: order.item }, 'shop order opened')

    return reply.send({
      orderId: order.id,
      item: order.item,
      to: config.TREASURY_ADDRESS,
      luna: String(order.priceLuna),
      nim: lunaToNim(order.priceLuna),
      memo: order.memo,
      expiresAt: order.expiresAt,
    })
  })

  app.get('/api/shop/orders/:id', { preHandler: deps.requireSession }, async (request, reply) => {
    const params = orderId.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: firstIssue(params.error) })

    const { address } = currentPlayer(request)
    const view = await getOrder(deps.db, params.data.id)

    // Somebody else's order reads as missing, so an id cannot be used to learn what
    // another wallet is buying.
    if (!view || view.order.address !== address) {
      return reply.code(404).send({ error: 'no such order' })
    }

    return reply.send({
      orderId: view.order.id,
      item: view.item.id,
      state: view.state,
      luna: String(view.order.priceLuna),
      nim: lunaToNim(view.order.priceLuna),
      memo: view.order.memo,
      to: config.TREASURY_ADDRESS,
      txHash: view.order.txHash,
      expiresAt: view.expiresAt,
    })
  })
}
