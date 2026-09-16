import { KeyPair } from '@nimiq/core'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildApp, type BuildOptions } from '../../src/app.js'
import type { Db } from '../../src/db/client.js'
import { signWithKeyPair } from '../../src/nimiq/verify.js'

/**
 * The real app wired to a throwaway database. Rate limits are lifted unless a test asks
 * for them, so a test that makes many calls is not measuring them.
 */
export async function testApp(db: Db, options: Partial<BuildOptions> = {}): Promise<FastifyInstance> {
  return buildApp({
    db,
    logger: false,
    rateLimit: { global: 100000, auth: 100000 },
    ...options,
  })
}

export function addressOf(keyPair: KeyPair): string {
  return keyPair.toAddress().toUserFriendlyAddress().replace(/\s+/g, '')
}

export type SignedIn = { token: string; address: string; auth: { authorization: string } }

/** The whole sign-in dance a phone does: ask for a challenge, sign it, send it back. */
export async function signIn(app: FastifyInstance, keyPair: KeyPair): Promise<SignedIn> {
  const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: {} })
  const { message } = challenge.json<{ message: string }>()
  const signed = signWithKeyPair(keyPair, message)

  const verified = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    payload: { message, publicKey: signed.publicKeyHex, signature: signed.signatureHex },
  })

  if (verified.statusCode !== 200) throw new Error(`sign in failed: ${verified.body}`)

  const body = verified.json<{ token: string; address: string }>()
  return { token: body.token, address: body.address, auth: { authorization: `Bearer ${body.token}` } }
}

/**
 * The app on a real port, which is the only way to prove anything about the socket:
 * app.inject never opens one. Port 0 lets the operating system pick a free port, so two
 * test files running at once cannot collide.
 */
export async function listenOnAnyPort(app: FastifyInstance): Promise<{ port: number; url: string }> {
  await app.listen({ port: 0, host: '127.0.0.1' })

  const address = app.server.address() as AddressInfo | null
  if (!address) throw new Error('the test server did not report a port')

  return { port: address.port, url: `http://127.0.0.1:${address.port}` }
}
