import type { DrawingRequest } from '../../../shared/charts/klineDrawingModel'
import type { ApiClient } from '../api/transport'

/**
 * The phone shows the drawings saved on the website and the desktop but cannot make, change or delete them. Its drawings service is a
 * read-only view of the server's: only these reads are allowed (a drawing list for one instrument, the chart colours and the symbol
 * catalogue the instrument identity needs), through the phone's Bearer transport. Anything else is refused before it is sent.
 */
const READABLE = /^(drawings\?instrument=[^&]+|chart-settings|catalogue)$/

export function createDrawingReader(client: ApiClient): DrawingRequest {
  return async (path, method) => {
    if (method !== 'GET' || !READABLE.test(path)) throw new Error('Drawings are read-only on the phone')
    return client.request(`/api/desktop/v1/${path}`, { method: 'GET', retries: 1 })
  }
}

interface CatalogueEntry { symbol: string; exchange: string; chart_type?: string }
/** The kind and exchange of a symbol, as the Day and Analysis charts use them (so the drawings' instrument key matches); the catalogue is read once. */
export function createSymbolResolver(read: DrawingRequest) {
  let catalogue: Promise<CatalogueEntry[]> | null = null
  return async (symbol: string): Promise<{ kind: string; exchange: string } | undefined> => {
    catalogue ??= (read('catalogue', 'GET') as Promise<{ instruments: CatalogueEntry[] }>).then(value => value.instruments).catch(error => { catalogue = null; throw error })
    const item = (await catalogue).find(entry => entry.symbol === symbol)
    return item ? { kind: item.chart_type ?? 'equity', exchange: item.exchange } : undefined
  }
}
