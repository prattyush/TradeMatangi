/** What the shell hands a market game besides the common view props (G3b): data access and the player's cost settings. */
import type { CostSettings } from './engine/costModel'
import type { MarketData } from './data/marketData'

export interface MarketHost {
  data: MarketData
  cost: CostSettings
  userId: string
  /** Local date `YYYY-MM-DD` (the no-repeat memory is by day). */
  today: string
}
