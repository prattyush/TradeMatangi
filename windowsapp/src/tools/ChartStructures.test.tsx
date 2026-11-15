import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

describe('ChartStructures (initial render)', () => {
  it('shows the three filters and the empty gallery before data arrives', async () => {
    vi.stubGlobal('window', { navigator: { userAgent: 'test' } })
    vi.stubGlobal('navigator', { userAgent: 'test' })
    vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
    const { default: ChartStructures } = await import('./ChartStructures')
    const html = renderToStaticMarkup(<ChartStructures baseUrl="http://x" token="t" onUnauthorized={() => undefined} active />)
    expect(html).toContain('Chart Structures')
    expect(html).toContain('Opening: All')
    expect(html).toContain('Midday: All')
    expect(html).toContain('Closing: All')
    expect(html).toContain('Broad')
    expect(html).toContain('Fine')
    // Fine stays mounted behind its tab: builder, search and definitions are all there before any day is loaded.
    expect(html).toContain('Underlying only')
    expect(html).toContain('Search by sequence')
    expect(html).toContain('Add definition')
    expect(html).not.toContain('desktop-analysis-chart')
  })
})
