// Covers the two pieces of the prove-it command that are worth proving on their own: the
// line a person reads and the name of the file a run is written to. It does NOT run the
// command, touch the chain, or start a world: prove.ts does all of that against the live
// testnet and writes its own output to docs/proofs. The caps themselves are proven in
// claims.test.ts and claims.caps.property.test.ts, and the run holds the server to the
// reason it prints rather than to any arithmetic of its own.

import { describe, expect, it } from 'vitest'
import { formatCheck, proofFileName } from '../src/cli/prove.js'

describe('formatCheck', () => {
  it('writes a passing check with its number, the word PASS and the reason', () => {
    const line = formatCheck({ number: 6, title: 'the treasury pays', ok: true, reason: 'block 11521663' })
    expect(line).toBe(' 6/12  PASS  the treasury pays: block 11521663')
  })

  it('writes a failing check the same way, with FAIL in the same column', () => {
    const passing = formatCheck({ number: 12, title: 'a', ok: true, reason: 'b' })
    const failing = formatCheck({ number: 12, title: 'a', ok: false, reason: 'b' })
    expect(failing).toBe('12/12  FAIL  a: b')
    expect(failing.indexOf('FAIL')).toBe(passing.indexOf('PASS'))
  })

  it('lines the single digit numbers up under the double digit ones', () => {
    const one = formatCheck({ number: 1, title: 'a', ok: true, reason: 'b' })
    const eleven = formatCheck({ number: 11, title: 'a', ok: true, reason: 'b' })
    expect(one.indexOf('PASS')).toBe(eleven.indexOf('PASS'))
  })

  it('keeps the whole result on one line, so a run reads as a list', () => {
    const line = formatCheck({ number: 3, title: 'forged and replayed', ok: false, reason: 'answered 200' })
    expect(line.split('\n')).toHaveLength(1)
  })
})

describe('proofFileName', () => {
  it('names the file after the minute the run started, sortable by name', () => {
    expect(proofFileName(new Date('2026-09-15T21:07:43.000Z'))).toBe('prove-20260915-2107.txt')
  })

  it('gives two runs in the same minute the same name, and a later run a later name', () => {
    const early = proofFileName(new Date('2026-09-15T21:07:00.000Z'))
    const late = proofFileName(new Date('2026-09-15T21:08:00.000Z'))
    expect(proofFileName(new Date('2026-09-15T21:07:59.000Z'))).toBe(early)
    expect(late > early).toBe(true)
  })
})
