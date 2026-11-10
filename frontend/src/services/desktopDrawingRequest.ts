import { BACKEND_URL } from '../config'
import { _authHeaders } from './api'
import api from './api'
import type { AnalysisEnvironment } from '../../../shared/analysis/environment'

/** Transport for `/api/desktop/v1/*` (persisted KLine drawings, chart settings). Same contract as WebsiteKLineChart. */
export const desktopDrawingRequest: NonNullable<AnalysisEnvironment['drawingRequest']> = async (path, method, body) => {
  const response = await fetch(`${BACKEND_URL}/api/desktop/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ..._authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Drawing request failed (${response.status})`)
  return data
}

let catalogue: ReturnType<typeof api.getSymbols> | undefined
/** Catalogue kind of an underlying; exchange mirrors WebsiteKLineChart so Analysis shares its drawings. */
export const resolveSymbolInstrument: NonNullable<AnalysisEnvironment['resolveSymbolInstrument']> = async symbol => {
  const request = catalogue ?? (catalogue = api.getSymbols().catch(error => { catalogue = undefined; throw error }))
  const info = (await request).find(item => item.symbol === symbol)
  return { kind: info?.chart_type ?? 'equity', exchange: symbol === 'BSESEN' ? 'BSE' : 'NSE' }
}
