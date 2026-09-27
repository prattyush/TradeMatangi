import { describe, expect, it } from 'vitest'
import { parseGuardrailError } from './guardrailFeedback'

describe('guardrail feedback', () => {
  it.each(['BLOCK', 'COOLDOWN', 'BAN'] as const)('recognizes %s in native and browser error bodies', type => {
    for (const limit of [220, 500]) {
      const body = JSON.stringify({ detail: `GUARDRAIL:${type}: trading paused` })
      expect(parseGuardrailError(new Error(`Trading request failed (403): ${body.slice(0, limit)}`))).toEqual({ type, reason: 'trading paused' })
    }
  })
  it('preserves Max Size and unrelated errors for ordinary feedback', () => {
    expect(parseGuardrailError('MAXSIZE: capital limit exceeded')).toBeNull()
    expect(parseGuardrailError('Trading request failed (401)')).toBeNull()
  })
})
