/**
 * Luna is Nimiq's smallest unit. Every amount Vettai stores, compares or pays is a
 * whole number of luna held in a bigint, so a reward can never lose a digit to floating
 * point and two caps can never disagree by a rounding error.
 */
export const LUNA_PER_NIM = 100_000n

const DECIMALS = 5

const AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * Turns "0.5" into 50000n. The string is read digit by digit rather than through
 * Number, because 0.1 + 0.2 is not 0.3 and a payout built that way would be wrong by a
 * luna or two on amounts people can see. More than five decimals is a mistake in the
 * caller's units, never a rounding job, so it throws instead of quietly truncating.
 */
export function nimToLuna(nim: string): bigint {
  if (typeof nim !== 'string') throw new TypeError(`${String(nim)} is not an amount of NIM`)

  const match = AMOUNT.exec(nim.trim())
  if (!match) throw new Error(`"${nim}" is not an amount of NIM`)

  const [, sign, whole = '0', fraction = ''] = match
  if (fraction.length > DECIMALS) {
    throw new Error(`"${nim}" has more than ${DECIMALS} decimals, which is finer than one luna`)
  }

  const luna = BigInt(whole) * LUNA_PER_NIM + BigInt(fraction.padEnd(DECIMALS, '0') || '0')
  return sign === '-' ? -luna : luna
}

/** The way an amount is written for people. No trailing zeros, never in exponent form. */
export function lunaToNim(luna: bigint): string {
  const negative = luna < 0n
  const absolute = negative ? -luna : luna
  const whole = absolute / LUNA_PER_NIM
  const fraction = String(absolute % LUNA_PER_NIM).padStart(DECIMALS, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}
