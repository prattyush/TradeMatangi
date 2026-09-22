import type { DesktopTrade } from './contracts'

export interface TradeMarker {
  id: string
  timestamp: number
  price: number
  text: string
  color: string
}

const markerStyle = (side: DesktopTrade['side']) => side === 'BUY'
  ? { color: '#FFFFFF', text: 'B' }
  : { color: '#00AAFF', text: 'S' }

const crossChartMarkerStyle = (right: 'CE' | 'PE', side: DesktopTrade['side']) => {
  if (right === 'CE') return side === 'BUY'
    ? { color: '#FFFFFF', text: 'CB' }
    : { color: '#00AAFF', text: 'CS' }
  return side === 'BUY'
    ? { color: '#00AAFF', text: 'PS' }
    : { color: '#FFFFFF', text: 'PB' }
}

export const buildTradeMarkers = (
  trades: DesktopTrade[],
  instrument: Record<string, unknown>,
  intervalSeconds: number,
  showHistoricalMarkers = true,
): TradeMarker[] => {
  const isOption = instrument.kind === 'option'
  const right = instrument.right as 'CE' | 'PE' | undefined
  const strike = Number(instrument.strike)
  return trades.flatMap(trade => {
    if (!showHistoricalMarkers && trade.is_open !== true) return []
    if (!Number.isFinite(trade.timestamp) || !Number.isFinite(trade.price) || trade.price <= 0) return []
    if (isOption) {
      if (trade.right !== right || Number(trade.strike) !== strike) return []
      const style = markerStyle(trade.side)
      return [{ id: trade.trade_id, timestamp: Math.floor(trade.timestamp / intervalSeconds) * intervalSeconds, price: trade.price, ...style }]
    }
    if (trade.right && (!Number.isFinite(Number(trade.underlying_price)) || Number(trade.underlying_price) <= 0)) return []
    const style = trade.right ? crossChartMarkerStyle(trade.right, trade.side) : markerStyle(trade.side)
    const price = trade.right ? Number(trade.underlying_price) : trade.price
    if (!Number.isFinite(price) || price <= 0) return []
    return [{ id: trade.trade_id, timestamp: Math.floor(trade.timestamp / intervalSeconds) * intervalSeconds, price, ...style }]
  })
}
