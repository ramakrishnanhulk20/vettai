// Covers the pieces of the prove-it command that are worth proving on their own: the line
// a person reads, the summary that counts it, the name of the file a run is written to,
// which mode the arguments ask for, and the address test that says whether a deployment
// reads its caller or its own edge. It does NOT run the command, touch the chain, or start
// a world: prove.ts does all of that against the live testnet or a deployment and writes
// its own output to docs/proofs. The caps themselves are proven in claims.test.ts and
// claims.caps.property.test.ts, and the run holds the server to the reason it prints
// rather than to any arithmetic of its own.

import { describe, expect, it } from 'vitest'
import {
  formatCheck,
  looksLikeProxyHop,
  proofFileName,
  readArguments,
  readEgressAddress,
  summaryLine,
  type CheckLine,
} from '../src/cli/prove.js'

const checkLine = (number: number, ok: boolean, skipped = false): CheckLine => ({
  number,
  title: 'a check',
  ok,
  reason: 'because',
  ...(skipped ? { skipped: true } : {}),
})

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

describe('formatCheck, for a check this mode cannot run', () => {
  it('writes SKIP in the same column as PASS, with the reason it was skipped', () => {
    const skipped = formatCheck({
      number: 7,
      title: 'the daily cap holds',
      ok: true,
      reason: 'remote: caps are configured on the host',
      skipped: true,
    })
    expect(skipped).toBe(' 7/12  SKIP  the daily cap holds: remote: caps are configured on the host')
    expect(skipped.indexOf('SKIP')).toBe(formatCheck(checkLine(7, true)).indexOf('PASS'))
  })
})

describe('summaryLine', () => {
  it('stays the short line when every check ran and passed', () => {
    const results = Array.from({ length: 12 }, (_, index) => checkLine(index + 1, true))
    expect(summaryLine(results)).toBe('12/12 passed')
  })

  it('counts a skipped check apart from a passed one and from a failure', () => {
    const results = [
      ...Array.from({ length: 7 }, (_, index) => checkLine(index + 1, true)),
      ...Array.from({ length: 5 }, (_, index) => checkLine(index + 8, true, true)),
    ]
    expect(summaryLine(results)).toBe('7/12 passed, 5 skipped, 0 failed')
  })

  it('names the failures when a check ran and did not hold', () => {
    const results = [checkLine(1, true), checkLine(2, false), checkLine(3, true, true)]
    expect(summaryLine(results)).toBe('1/12 passed, 1 skipped, 1 failed')
  })
})

describe('proofFileName, for a run against a deployment', () => {
  it('marks the file remote so the two kinds of run never share a name', () => {
    const at = new Date('2026-09-16T08:30:00.000Z')
    expect(proofFileName(at, 'remote')).toBe('prove-remote-20260916-0830.txt')
    expect(proofFileName(at, 'local')).toBe('prove-20260916-0830.txt')
  })
})

describe('readArguments', () => {
  it('runs the local world when nothing names a deployment', () => {
    expect(readArguments([], {})).toEqual({ mode: 'local', origin: '', fund: false, expectDailyCap: '' })
  })

  it('takes --url as the deployment to prove and keeps only its origin', () => {
    expect(readArguments(['--url', 'https://world.up.railway.app/health'], {})).toEqual({
      mode: 'remote',
      origin: 'https://world.up.railway.app',
      fund: false,
      expectDailyCap: '',
    })
  })

  it('reads VETTAI_PROVE_URL when no --url is written', () => {
    expect(readArguments([], { VETTAI_PROVE_URL: 'https://world.up.railway.app' }).mode).toBe('remote')
    expect(readArguments([], { VETTAI_PROVE_URL: '  ' }).mode).toBe('local')
  })

  it('turns the shop check on only when --fund is asked for', () => {
    expect(readArguments(['--url', 'https://a.example', '--fund'], {}).fund).toBe(true)
    expect(readArguments(['--url', 'https://a.example'], {}).fund).toBe(false)
  })

  it('carries the daily cap a deployment is expected to be running', () => {
    const asked = readArguments(['--url', 'https://a.example', '--expect-daily-cap', '5'], {})
    expect(asked.expectDailyCap).toBe('5')
    expect(readArguments(['--url', 'https://a.example'], {}).expectDailyCap).toBe('')
  })

  it('refuses a --url that is not an http address, rather than guessing one', () => {
    expect(() => readArguments(['--url', 'railway.app'], {})).toThrow(/not a URL/)
    expect(() => readArguments(['--url', 'ftp://world.example'], {})).toThrow(/http or https/)
    expect(() => readArguments(['--url'], { VETTAI_PROVE_URL: 'https://a.example' })).toThrow(/--url needs/)
  })
})

describe('looksLikeProxyHop', () => {
  it('knows every range no caller could have arrived from', () => {
    expect(looksLikeProxyHop('100.64.0.7')).toBe(true)
    expect(looksLikeProxyHop('100.127.255.254')).toBe(true)
    expect(looksLikeProxyHop('10.250.1.1')).toBe(true)
    expect(looksLikeProxyHop('172.16.0.1')).toBe(true)
    expect(looksLikeProxyHop('172.31.255.254')).toBe(true)
    expect(looksLikeProxyHop('192.168.1.20')).toBe(true)
    expect(looksLikeProxyHop('127.0.0.1')).toBe(true)
  })

  it('leaves a real caller alone, including the edges of those ranges', () => {
    expect(looksLikeProxyHop('100.63.255.255')).toBe(false)
    expect(looksLikeProxyHop('100.128.0.1')).toBe(false)
    expect(looksLikeProxyHop('172.15.0.1')).toBe(false)
    expect(looksLikeProxyHop('172.32.0.1')).toBe(false)
    expect(looksLikeProxyHop('192.169.0.1')).toBe(false)
    expect(looksLikeProxyHop('86.19.4.2')).toBe(false)
    expect(looksLikeProxyHop('152.233.19.4')).toBe(false)
    expect(looksLikeProxyHop('2a02:c7c:1::1')).toBe(false)
    expect(looksLikeProxyHop('')).toBe(false)
  })
})

describe('readEgressAddress', () => {
  it('takes the one address the service prints, and nothing else', () => {
    expect(readEgressAddress('  86.19.4.2  ')).toBe('86.19.4.2')
    expect(readEgressAddress(' 2a02:c7c:1::1 ')).toBe('2a02:c7c:1::1')
    expect(() => readEgressAddress('<html>rate limited</html>')).toThrow(/not an address/)
    expect(() => readEgressAddress('')).toThrow(/not an address/)
  })
})
