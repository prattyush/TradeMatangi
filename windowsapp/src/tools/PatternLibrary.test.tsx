import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

describe('PatternLibrary (initial render)', () => {
  it('shows the load form, the two tabs and no chart before a day is loaded', async () => {
    vi.stubGlobal('window', { navigator: { userAgent: 'test' } })
    vi.stubGlobal('navigator', { userAgent: 'test' })
    vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
    const { default: PatternLibrary } = await import('./PatternLibrary')
    const html = renderToStaticMarkup(<PatternLibrary baseUrl="http://x" token="t" onUnauthorized={() => undefined} active />)
    expect(html).toContain('Pattern Library')
    expect(html).toContain('Annotate')
    expect(html).toContain('Saved charts (0)')
    expect(html).toContain('Load chart')
    expect(html).not.toContain('desktop-analysis-chart')
    expect(html).not.toContain('Mark:')
  })
})
