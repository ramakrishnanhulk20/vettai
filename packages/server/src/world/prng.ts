/**
 * The one source of randomness in the world. Every map and every drone spawn comes from a
 * string seed, so the server and the client draw the same city and a room can be replayed
 * from its seed plus the inputs. Math.random is never used anywhere under src/world.
 */

/** A 32 bit unsigned hash of a string (xmur3's mixing step). Stable across runs and machines. */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * A mulberry32 generator seeded from a string. Returns numbers in [0, 1).
 * The same seed always gives the same sequence, on any JavaScript engine, because every
 * step is 32 bit integer maths.
 */
export function seeded(seed: string): () => number {
  let state = hashSeed(seed)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
