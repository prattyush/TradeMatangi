import { PatternAnnotation, TopPatterns } from './api'
import { SeriesMarker, Time } from 'lightweight-charts'

export const MARKER_COLORS: Record<string, { color: string; shape: 'arrowUp' | 'arrowDown' }> = {
  'entry-underlying': { color: '#3b82f6', shape: 'arrowUp' },
  'exit-underlying':  { color: '#f97316', shape: 'arrowDown' },
  'entry-CE':         { color: '#22c55e', shape: 'arrowUp' },
  'exit-CE':          { color: '#ef4444', shape: 'arrowDown' },
  'entry-PE':         { color: '#14b8a6', shape: 'arrowUp' },
  'exit-PE':          { color: '#7c3aed', shape: 'arrowDown' },
}

export function markerKey(type: string, instrument: string) { return `${type}-${instrument}` }

export function patternIdentity(ann: { strategy_name: string; category?: string }): string {
  return `${ann.strategy_name}::${ann.category || ''}`
}

export function rankingForIdentity(topPatterns: TopPatterns | undefined, identity: string): 'top_1' | 'top_2' | 'bottom_1' | null {
  if (!topPatterns) return null
  for (const rank of ['top_1', 'top_2', 'bottom_1'] as const) {
    const tp = topPatterns[rank]
    if (tp && `${tp.strategy_name}::${tp.category}` === identity) return rank
  }
  return null
}

export const TOP_RANK_STYLE: Record<string, { color: string; badge: string }> = {
  top_1: { color: '#FFD700', badge: '🥇' },
  top_2: { color: '#C0C0C0', badge: '🥈' },
  bottom_1: { color: '#ff4444', badge: '❌' },
}

export function buildMarkers(
  annotations: PatternAnnotation[],
  activeStrategy: string | null,
  activeCategory: string | null,
  topPatterns?: TopPatterns,
): SeriesMarker<Time>[] {
  return annotations
    .slice()
    .sort((a, b) => a.time - b.time)
    .map(ann => {
      const cfg = MARKER_COLORS[markerKey(ann.type, ann.instrument)] ?? { color: '#8b949e', shape: 'arrowUp' as const }
      const matchedStrategy = activeStrategy === null || ann.strategy_name === activeStrategy
      const matchedCategory = activeCategory === null || ann.category === activeCategory
      const dimmed = !matchedStrategy || !matchedCategory

      const rank = rankingForIdentity(topPatterns, patternIdentity(ann))
      const rankStyle = rank ? TOP_RANK_STYLE[rank] : null

      const displayText = dimmed
        ? ''
        : [
            rankStyle ? rankStyle.badge : '',
            ann.category ? ann.category.slice(0, 5) + '/' : '',
            ann.strategy_name.slice(0, 10),
          ].join('')

      return {
        time: ann.time as Time,
        position: ann.type === 'entry' ? 'belowBar' : 'aboveBar',
        color: dimmed ? '#3d4450' : rankStyle ? rankStyle.color : cfg.color,
        shape: cfg.shape,
        text: displayText,
        size: rankStyle ? 3 : dimmed ? 1 : 2,
      } as SeriesMarker<Time>
    })
}

export function cleanTopPatterns(tp: TopPatterns): TopPatterns {
  const cleaned: TopPatterns = {}
  for (const rank of ['top_1', 'top_2', 'bottom_1'] as const) {
    const item = tp[rank]
    if (item) cleaned[rank] = { strategy_name: item.strategy_name, category: item.category }
  }
  return cleaned
}
