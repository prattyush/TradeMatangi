/**
 * How an order or exit happened, as a short code, a name and a tone (for colour). Used by Trade Walkthrough.
 * Codes follow the user's suggestions: BL = buy limit, SL = sell limit, SS = sell stoploss, TP = take-profit strategy.
 */
export type MethodTone = 'market' | 'limit' | 'stop' | 'target' | 'strategy' | 'close' | 'unknown'
export interface MethodInfo { code: string; name: string; tone: MethodTone }

const buy = (side: string | undefined) => (side ?? '').toUpperCase() === 'BUY'

/** An exit: `method` is the confirmed controller (an order type or a strategy), `side` the side of the exit fill. */
export function exitMethodInfo(method: string | null | undefined, side?: string): MethodInfo {
  const b = buy(side)
  switch (method) {
    case 'MARKET': return { code: 'MKT', name: 'Market exit', tone: 'market' }
    case 'LIMIT': return b ? { code: 'BL', name: 'Buy limit', tone: 'limit' } : { code: 'SL', name: 'Sell limit', tone: 'limit' }
    case 'STOPLOSS': return b ? { code: 'BS', name: 'Buy stoploss', tone: 'stop' } : { code: 'SS', name: 'Sell stoploss', tone: 'stop' }
    case 'TARGET': return b ? { code: 'BT', name: 'Buy target', tone: 'target' } : { code: 'ST', name: 'Sell target', tone: 'target' }
    case 'TargetProfit': return { code: 'TP', name: 'Take-profit strategy', tone: 'strategy' }
    case 'UnderlyingTargetProfit': return { code: 'UTP', name: 'Underlying take-profit strategy', tone: 'strategy' }
    case 'AggressiveStoploss': return { code: 'AGS', name: 'Aggressive stoploss strategy', tone: 'stop' }
    case 'UnderlyingStoploss': return { code: 'USL', name: 'Underlying stoploss strategy', tone: 'stop' }
    case 'BreakEven': return { code: 'BE', name: 'Break-even strategy', tone: 'strategy' }
    case 'LockProfit': return { code: 'LP', name: 'Lock-profit strategy', tone: 'strategy' }
    case 'AutoStop': return { code: 'AS', name: 'AutoStop', tone: 'stop' }
    case 'SESSION_CLOSE': return { code: 'SC', name: 'Session close', tone: 'close' }
    case 'EOD_CLOSE': return { code: 'EOD', name: 'End-of-day close', tone: 'close' }
    default: return { code: '?', name: 'Unknown (not recorded)', tone: 'unknown' }
  }
}

/** An entry: how the order that opened it was placed (`entry_method`). */
export function entryMethodInfo(method: string | null | undefined, side?: string): MethodInfo {
  const b = buy(side)
  switch (method) {
    case 'MARKET': return { code: 'MKT', name: 'Market entry', tone: 'market' }
    case 'LIMIT': return b ? { code: 'BL', name: 'Buy limit', tone: 'limit' } : { code: 'SL', name: 'Sell limit', tone: 'limit' }
    case 'TARGET': return b ? { code: 'BT', name: 'Buy target', tone: 'target' } : { code: 'ST', name: 'Sell target', tone: 'target' }
    case 'AUTOSTOP': return { code: 'AS', name: 'AutoStop entry', tone: 'stop' }
    case 'AUTOSTOP_LIMIT': return { code: 'ASL', name: 'AutoStop limit entry', tone: 'stop' }
    default: return { code: '?', name: 'Unknown (not recorded)', tone: 'unknown' }
  }
}

export const TONE_COLORS: Record<MethodTone, { fg: string; bg: string }> = {
  market: { fg: '#c9d1d9', bg: '#30363d' },
  limit: { fg: '#a5d6ff', bg: '#0f3a5f' },
  stop: { fg: '#ffb3ad', bg: '#5a1d1d' },
  target: { fg: '#8fd9a8', bg: '#1f3a2b' },
  strategy: { fg: '#d2c3ff', bg: '#3b2f63' },
  close: { fg: '#f2cc60', bg: '#4d3b0b' },
  unknown: { fg: '#8b949e', bg: '#21262d' },
}
