import { describe, expect, it } from 'vitest'
import { guardrailFields } from './GuardrailSettings'

describe('guardrail settings fields', () => {
  const keys = guardrailFields.map(field => field[0]) as string[]

  it('offers the per-entry cap with its own switch, unit and amounts', () => {
    for (const key of ['guardrail_maxentry_enabled', 'guardrail_maxentry_mode', 'guardrail_maxentry_pct', 'guardrail_maxentry_value']) {
      expect(keys).toContain(key)
    }
  })

  it('offers the minimum gap with a switch and a whole-minute input from 1 to 390', () => {
    expect(keys).toContain('guardrail_mingap_enabled')
    const minutes = guardrailFields.find(field => field[0] === 'guardrail_mingap_minutes') as readonly unknown[]
    expect(minutes.slice(2)).toEqual([1, 390, 1])
  })

  it('keeps every key unique so each setting renders once', () => {
    expect(new Set(keys).size).toBe(keys.length)
  })
})
