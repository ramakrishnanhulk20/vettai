// Covers the server side of wallet login only. It does NOT cover the live phone
// dialog: no test here proves Nimiq Pay's sign() returns hex in this exact shape, or
// that a user can approve the native popup at all. That is what the spike page is for.

import { describe, expect, it } from 'vitest'
import { KeyPair } from '@nimiq/core'
import { signWithKeyPair, verifySignedMessage } from '../src/nimiq/verify.js'

const MESSAGE = 'vettai-login:0123456789abcdef0123456789abcdef:1789117263760'

describe('verifySignedMessage', () => {
  it('verifies a signature produced by @nimiq/core over the Nimiq signed-message prefix', () => {
    const signed = signWithKeyPair(KeyPair.generate(), MESSAGE)

    const result = verifySignedMessage(signed)

    expect(result).toEqual({ ok: true, address: signed.address })
  })

  it('reads the address off the key rather than taking one from the caller', () => {
    const wallet = KeyPair.generate()
    const signed = signWithKeyPair(wallet, MESSAGE)

    const result = verifySignedMessage({
      message: MESSAGE,
      publicKeyHex: signed.publicKeyHex,
      signatureHex: signed.signatureHex,
    })

    expect(result).toEqual({
      ok: true,
      address: wallet.toAddress().toUserFriendlyAddress().replace(/\s+/g, ''),
    })
  })

  it('rejects a message changed by a single character after signing', () => {
    const signed = signWithKeyPair(KeyPair.generate(), MESSAGE)

    const result = verifySignedMessage({ ...signed, message: `${MESSAGE.slice(0, -1)}1` })

    expect(result).toEqual({ ok: false, reason: 'signature does not match message' })
  })

  it('rejects a signature made by a different key', () => {
    const signed = signWithKeyPair(KeyPair.generate(), MESSAGE)
    const impostor = signWithKeyPair(KeyPair.generate(), MESSAGE)

    const result = verifySignedMessage({ ...signed, signatureHex: impostor.signatureHex })

    expect(result).toEqual({ ok: false, reason: 'signature does not match message' })
  })

  it('rejects malformed hex and an empty message', () => {
    const signed = signWithKeyPair(KeyPair.generate(), MESSAGE)

    expect(verifySignedMessage({ ...signed, publicKeyHex: 'zz' })).toEqual({ ok: false, reason: 'malformed public key' })
    expect(verifySignedMessage({ ...signed, signatureHex: 'deadbeef' })).toEqual({ ok: false, reason: 'malformed signature' })
    expect(verifySignedMessage({ ...signed, message: '' })).toEqual({ ok: false, reason: 'missing message' })
  })
})
