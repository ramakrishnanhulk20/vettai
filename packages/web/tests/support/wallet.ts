import { Hash, KeyPair } from "@nimiq/core";

/**
 * A throwaway Nimiq wallet that signs the way Nimiq Pay signs.
 *
 * The prefix and the length byte are the ones the wallet puts in front of a message before
 * it hashes it, written out again here rather than reached across for: this package cannot
 * import from the world server. The one place they are defined for real is
 * packages/server/src/nimiq/verify.ts, and the world verifies every signature these tests
 * produce, so a drift between the two shows up as a refused sign in rather than silently.
 */

const PREFIX = "\x16Nimiq Signed Message:\n";
const encoder = new TextEncoder();

function encodeSignedMessage(message: string): Uint8Array {
  const body = encoder.encode(message);
  const head = encoder.encode(`${PREFIX}${body.byteLength}`);
  const payload = new Uint8Array(head.byteLength + body.byteLength);
  payload.set(head);
  payload.set(body, head.byteLength);
  return payload;
}

export type Signed = { publicKey: string; signature: string };

export type Wallet = {
  address: string;
  sign: (message: string) => Signed;
};

export function newWallet(): Wallet {
  const pair = KeyPair.generate();
  const publicKey = pair.publicKey.toHex();
  return {
    address: pair.toAddress().toUserFriendlyAddress(),
    sign: (message) => ({
      publicKey,
      signature: pair.sign(Hash.computeSha256(encodeSignedMessage(message))).toHex(),
    }),
  };
}
