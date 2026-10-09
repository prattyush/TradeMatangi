export interface PreparationTile {
  id: string; kind: 'spot' | 'option'; symbol: string; interval: string; tradingDate: string; expiry: string; strike: string; right: string
  selection_mode?: 'manual' | 'max_price'; max_price?: number | null
}
export interface PreparedSession {
  version: number; date: string; reference_time: string
  panes: Array<{ pane: PreparationTile; availability: 'available' | 'waiting' | 'unavailable' | 'error'; reason: string | null; premium: number | null }>
}
export function retainedPanes(result: PreparedSession): PreparationTile[] {
  if (!Array.isArray(result.panes)) throw new Error('Update the backend to support desktop session preparation')
  const failed = result.panes.find(item => item.availability === 'error')
  if (failed) throw new Error(`${failed.pane.symbol}: ${failed.reason ?? 'Provider unavailable; retry'}`)
  const tiles = result.panes.filter(item => item.availability === 'available' || item.availability === 'waiting').map(item => item.pane)
  if (!tiles.length) throw new Error(result.panes.map(item => item.reason).filter(Boolean).join('; ') || 'No valid charts remain; choose another date or instrument')
  return tiles
}
export const compactLayout = (count: number) => (['1', '2-side', '3-wide-top', '4-grid', '5-equal'] as const)[Math.max(0, Math.min(4, count - 1))]
