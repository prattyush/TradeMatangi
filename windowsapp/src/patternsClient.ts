import type { PatternAnnotation, PatternChart, PatternChartMeta, TopPatterns } from '../../shared/analysis/api'
import type { PatternsRequest } from './patternsApi'

const query = (values: Record<string, unknown>) => {
  const q = new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()
  return q ? `?${q}` : ''
}

export interface StructureType { value: string; label: string }
export interface ChartStructureItem {
  chart_structure_id: string; symbol: string; date: string
  opening_type: string; midday_type: string; closing_type: string
  is_predefined: boolean; user_id: string; created_at: string; updated_at: string; can_delete: boolean
}
export interface StructureTypes { opening_types: StructureType[]; midday_types: StructureType[]; closing_types: StructureType[] }
export interface StructureFilters { opening_types?: string[]; midday_types?: string[]; closing_types?: string[] }
export interface StructureClassification { opening_type: string; midday_type: string; closing_type: string }
export interface StructureCandle { time: number; open: number; high: number; low: number; close: number }

export interface SaveChartBody {
  symbol: string; date: string; instrument_type: string
  annotations: PatternAnnotation[]; notes: string
  right?: string; strike?: number; strike_pe?: number
  top_patterns?: TopPatterns; risk_reward_ratios?: Record<string, string>; interval_minutes?: number
}

/** Pattern Library calls on the desktop transport; same shapes as the website's `services/api.ts` methods. */
export function createPatternsClient(request: PatternsRequest) {
  return {
    listStrategies: () => request<{ strategies: string[] }>('pattern/strategies', 'GET'),
    listCategories: () => request<{ categories: string[] }>('pattern/categories', 'GET'),
    addStrategy: (name: string) => request<{ strategies: string[] }>('pattern/strategies', 'POST', { name }),
    addCategory: (name: string) => request<{ categories: string[] }>('pattern/categories', 'POST', { name }),
    listCharts: (strategy?: string, category?: string, topOnly?: boolean) =>
      request<{ charts: PatternChartMeta[] }>(`pattern/charts${query({ strategy, category, top_only: topOnly ? 'true' : undefined })}`, 'GET'),
    getChart: (chartId: string) => request<PatternChart>(`pattern/chart/${encodeURIComponent(chartId)}`, 'GET'),
    getChartByDate: async (symbol: string, date: string, instrumentType: string, right?: string) => {
      try { return await request<PatternChart>(`pattern/chart/by-date${query({ symbol, date, instrument_type: instrumentType, right })}`, 'GET') }
      catch (error) { if (/\b404\b/.test(String(error))) return null; throw error }
    },
    createChart: (body: SaveChartBody) => request<PatternChart>('pattern/chart', 'POST', body),
    updateChart: (chartId: string, body: Omit<SaveChartBody, 'symbol' | 'date' | 'instrument_type'>) =>
      request<PatternChart>(`pattern/chart/${encodeURIComponent(chartId)}`, 'PUT', body),
    deleteChart: (chartId: string) => request<void>(`pattern/chart/${encodeURIComponent(chartId)}`, 'DELETE'),
    bulkDeleteCharts: (chartIds: string[]) => request<{ deleted: string[]; failed: Array<{ chart_id: string; reason: string }> }>('pattern/charts/bulk-delete', 'POST', { chart_ids: chartIds }),
    structureTypes: () => request<StructureTypes>('chart-structures/types', 'GET'),
    listStructures: (filters: StructureFilters = {}) => request<{ structures: ChartStructureItem[] }>(`chart-structures/structures${query({
      opening_types: filters.opening_types?.join(','), midday_types: filters.midday_types?.join(','), closing_types: filters.closing_types?.join(','),
    })}`, 'GET'),
    structureOhlc: (symbol: string, date: string, intervalMinutes = 3, daysBack?: number) =>
      request<{ candles: StructureCandle[]; structure: ChartStructureItem | null }>(`chart-structures/ohlc/${encodeURIComponent(symbol)}/${date}${query({ interval_minutes: intervalMinutes, days_back: daysBack })}`, 'GET'),
    createStructure: (body: StructureClassification & { symbol: string; date: string }) => request<ChartStructureItem>('chart-structures/structure', 'POST', body),
    updateStructure: (id: string, body: StructureClassification) => request<ChartStructureItem>(`chart-structures/structure/${encodeURIComponent(id)}`, 'PUT', body),
    getExpiry: (symbol: string, date: string) => request<{ expiry: string }>(`data/expiry${query({ symbol, date })}`, 'GET'),
    getPriceAt: (symbol: string, date: string, time: string) =>
      request<{ price: number }>(`data/price-at${query({ symbol, date, time, history_mode: 'replay', granularity: 'minute' })}`, 'GET'),
    findStrikeByPrice: (symbol: string, date: string, expiry: string, right: 'CE' | 'PE', maxPrice: number, referenceTime: string) =>
      request<{ strike: number; price: number }>(`data/options/find-strike-by-price${query({ symbol, date, expiry, right, max_price: maxPrice, reference_time: referenceTime, history_mode: 'replay', granularity: 'minute' })}`, 'GET'),
  }
}
export type PatternsClient = ReturnType<typeof createPatternsClient>
