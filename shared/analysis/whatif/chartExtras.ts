import type { WhatIfMarker } from './whatIfModel'

/**
 * What the What If tab asks of a chart besides the usual trades: which chart (underlying or option) listens for a price pick,
 * what to do with the pick, and the edited legs to draw. Charts that cannot do it (Lightweight) simply ignore these.
 */
export interface WhatIfChartExtras {
  pickTarget?: 'underlying' | 'option' | null
  onPick?: (point: { time: number; price: number }) => void
  onPickCancel?: () => void
  pickHint?: string
  whatIfMarkers?: WhatIfMarker[]
}
