import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PATTERN_SYMBOLS, symbolChoices } from '../../shared/deepdive/symbols'
import { STRIKE_INTERVALS } from '../../shared/deepdive/strikes'

describe('Deep Dive symbols', () => {
  const page = readFileSync(new URL('../../frontend/src/pages/PatternLibrary.tsx', import.meta.url), 'utf8')
  const pageList = (/const SUPPORTED_SYMBOLS = \[([^\]]+)\]/.exec(page)?.[1] ?? '').match(/'([A-Z0-9]+)'/g)?.map(item => item.replace(/'/g, ''))
  const pageIntervals = Object.fromEntries([...(/const STRIKE_INTERVALS[^=]*= \{([^}]+)\}/.exec(page)?.[1] ?? '').matchAll(/([A-Z0-9]+):\s*(\d+)/g)].map(match => [match[1], Number(match[2])]))

  it('offers exactly the symbols the website Pattern Library page offers', () => {
    expect(pageList).toBeDefined()
    expect(PATTERN_SYMBOLS.map(item => item.symbol)).toEqual(pageList)
    expect(PATTERN_SYMBOLS.map(item => item.symbol)).toEqual(['NIFTY', 'BSESEN', 'RELIND', 'TATMOT', 'TATPOW'])
  })

  it('has the same strike gaps as the Pattern Library page, so a stock gets option strikes at its own gap', () => {
    expect(STRIKE_INTERVALS).toEqual(pageIntervals)
    expect(STRIKE_INTERVALS.RELIND).toBe(5)
  })

  it('labels the dropdown with the names and keeps a symbol a saved deep dive already uses', () => {
    const labels = Object.fromEntries(symbolChoices('NIFTY').map(choice => [choice.symbol, choice.label]))
    expect(labels).toEqual({ NIFTY: 'NIFTY 50 (NIFTY)', BSESEN: 'SENSEX (BSESEN)', RELIND: 'Reliance Industries (RELIND)', TATMOT: 'Tata Motors CV (TATMOT)', TATPOW: 'Tata Power (TATPOW)' })
    expect(symbolChoices('INFY').map(choice => choice.symbol)).toEqual(['NIFTY', 'BSESEN', 'RELIND', 'TATMOT', 'TATPOW', 'INFY'])
    expect(symbolChoices('')).toHaveLength(5)
  })
})
