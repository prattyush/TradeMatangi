import { describe, expect, it } from 'vitest'
import { metadataQuery } from './optionMetadata'
import { sharedSettingsSections } from './settingsFields'

describe('option metadata query', () => {
  it('asks for the trading expiry only when a session is being set up', () => {
    expect(metadataQuery('NIFTY', '2026-11-17', true)).toEqual({ symbol: 'NIFTY', as_of_date: '2026-11-17', purpose: 'trading' })
    expect(metadataQuery('NIFTY', '2026-11-17', false)).toEqual({ symbol: 'NIFTY', as_of_date: '2026-11-17' })
  })
})

describe('the Next expiry on expiry days setting', () => {
  it('is a Trading toggle with its explanation as a tooltip, not as text', () => {
    const field = sharedSettingsSections.Trading.find(item => item.key === 'next_expiry_on_expiry_day')
    expect(field).toMatchObject({ label: 'Next expiry on expiry days', type: 'boolean' })
    expect(field?.help).toMatch(/next expiry/i)
    expect(field?.label).not.toMatch(/\./)
  })
})
