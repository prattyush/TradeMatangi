import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AnalysisEnvironment } from '../../../shared/analysis/environment'
import { analysisRequest, createAnalysisApi, type AnalysisRequest } from '../analysisApi'
import { createPatternsClient } from '../patternsClient'
import { patternsRequest, type PatternsRequest } from '../patternsApi'

export const native = '__TAURI_INTERNALS__' in window

/** `loaded` is false until the account's settings have been read (or the read failed), so a screen can wait before it resolves strikes. */
export interface PatternSettings { mode: string; ceCap: number; peCap: number; historicalDays: number; loaded?: boolean }

/**
 * What every Patterns tool (Pattern Library, Chart Structures, Fine Structures) needs: the typed patterns client, the
 * Analysis environment its KLine charts read, and the account's Max Price / historical-days settings.
 */
export function usePatternsRuntime(baseUrl: string, token: string, onUnauthorized: () => void, active: boolean) {
  const client = useMemo(() => {
    const request: PatternsRequest = patternsRequest(baseUrl, (command, args) => invoke(command, args))
    return createPatternsClient(request)
  }, [baseUrl])
  const adapter = useMemo(() => {
    const nativeRequest: AnalysisRequest | undefined = native
      ? <T,>(path: string, method: string, body?: unknown) => invoke<T>('desktop_analysis_request', { baseUrl, path, method, body: body ?? {} }) : undefined
    return createAnalysisApi(analysisRequest(baseUrl, token, nativeRequest, onUnauthorized))
  }, [baseUrl, token, onUnauthorized])
  useEffect(() => () => adapter.dispose(), [adapter])

  const [settings, setSettings] = useState<PatternSettings>({ mode: 'otm', ceCap: 0, peCap: 0, historicalDays: 2, loaded: !native })
  useEffect(() => {
    if (!active || !native) return
    let cancelled = false
    void invoke<Record<string, unknown>>('desktop_drawing_request', { baseUrl, path: 'trading/settings/current', method: 'GET', body: {} }).then(value => {
      if (cancelled) return
      setSettings({ mode: String(value.max_price_mode ?? 'otm'), ceCap: Number(value.max_price_threshold_ce) || 0, peCap: Number(value.max_price_threshold_pe) || 0, historicalDays: Number(value.historical_days) || 2, loaded: true })
    }).catch(() => { if (!cancelled) setSettings(current => ({ ...current, loaded: true })) })
    return () => { cancelled = true }
  }, [baseUrl, active])

  // Drawing tools persist through the same desktop transport and instrument keys as the trading charts.
  const drawingRequest = useCallback((path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}) =>
    native ? invoke<unknown>('desktop_drawing_request', { baseUrl, path, method, body }) : Promise.reject(new Error('Drawing tools need the desktop app')), [baseUrl])
  const catalogue = useRef<Promise<Array<{ symbol: string; exchange: string; chart_type?: string }>> | null>(null)
  const resolveSymbolInstrument = useCallback(async (symbol: string) => {
    if (!native) return undefined
    const request = catalogue.current ?? (catalogue.current = drawingRequest('catalogue', 'GET').then(value => (value as { instruments: Array<{ symbol: string; exchange: string; chart_type?: string }> }).instruments).catch(error => { catalogue.current = null; throw error }))
    const item = (await request).find(entry => entry.symbol === symbol)
    return item ? { kind: item.chart_type ?? 'equity', exchange: item.exchange } : undefined
  }, [drawingRequest])

  const environment: AnalysisEnvironment = useMemo(() => ({
    api: adapter.api, performance: adapter.performance, desktop: true, active, historicalDays: settings.historicalDays,
    chartPicking: true, drawingRequest: native ? drawingRequest : undefined, resolveSymbolInstrument,
  }), [adapter, active, settings.historicalDays, drawingRequest, resolveSymbolInstrument])

  return { client, environment, settings }
}
