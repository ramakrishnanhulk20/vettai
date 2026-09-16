import type { FastifyInstance } from 'fastify'
import { publicStats } from '../domain/stats.js'
import type { RouteDeps } from './context.js'

export function registerStatsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // The landing page reads this and nothing else, so every number on it is one the
  // server counted from its own rows.
  app.get('/api/stats', async (_request, reply) => {
    const stats = await publicStats(deps.db)

    return reply.send({
      day: stats.day,
      playersToday: stats.playersToday,
      playersAllTime: stats.playersAllTime,
      killsToday: stats.killsToday,
      paidLuna: String(stats.paidLuna),
      paidNim: stats.paidNim,
      claimsPaid: stats.claimsPaid,
      history: stats.history,
    })
  })
}
