import { describe, expect, it } from 'vitest'
import { feedNotice } from '../../shared/liveFeedNotice'

describe('feedNotice', () => {
  it('says nothing while the feed is healthy, so the chart keeps the row', () => {
    expect(feedNotice({ selected_provider: 'kite', actual_provider: 'kite', connection: 'connected' })).toBeNull()
    expect(feedNotice({ selected_provider: 'kite', connection: 'connected' })).toBeNull()
    expect(feedNotice(null)).toBeNull()
    expect(feedNotice(undefined)).toBeNull()
  })

  it('speaks up while the feed is not connected', () => {
    for (const connection of ['connecting', 'reconnecting', 'unavailable']) {
      expect(feedNotice({ selected_provider: 'kite', actual_provider: 'kite', connection })).toBe(`Feed kite · ${connection}`)
    }
    expect(feedNotice({ selected_provider: 'kite', actual_provider: null, connection: 'connecting' })).toBe('Feed kite · connecting')
  })

  it('names a fallback provider even when it is connected', () => {
    expect(feedNotice({ selected_provider: 'kite', actual_provider: 'breeze', connection: 'connected' })).toBe('Feed breeze · connected (fallback from kite)')
    expect(feedNotice({ selected_provider: 'kite', actual_provider: 'breeze', connection: 'reconnecting' })).toBe('Feed breeze · reconnecting (fallback from kite)')
  })
})
