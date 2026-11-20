import { describe, expect, it } from 'vitest'
import { friendlyError, UNREACHABLE_SERVER, UNSUPPORTED_SERVER } from '../../shared/deepdive/ui/errors'

describe('friendlyError', () => {
  it('says what a missing route means (an older backend), however the transport words it', () => {
    expect(friendlyError(new Error('Not Found'))).toBe(UNSUPPORTED_SERVER)
    expect(friendlyError(new Error('Patterns request failed (404): {"detail":"Not Found"}'))).toBe(UNSUPPORTED_SERVER)
    expect(friendlyError(new Error('Deep dive request failed: 404'))).toBe(UNSUPPORTED_SERVER)
    expect(friendlyError('Not Found')).toBe(UNSUPPORTED_SERVER)
  })

  it('says a connection that did not get through', () => {
    for (const message of ['Failed to fetch', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      expect(friendlyError(new Error(message)), message).toBe(UNREACHABLE_SERVER)
    }
  })

  it('leaves the server\'s own sentences alone, including its own "not found"', () => {
    for (const message of ['The selected date is not a trading day', 'Deep dive not found', 'Tag not found', 'An active tag with this name already exists']) {
      expect(friendlyError(new Error(message))).toBe(message)
    }
    expect(friendlyError(new Error('Patterns request failed (400): {"detail":"A deep dive day must be before today"}'))).toBe('A deep dive day must be before today')
    expect(friendlyError(new Error('Patterns request failed (404): {"detail":"Deep dive not found"}'))).toBe('Deep dive not found')
  })
})
