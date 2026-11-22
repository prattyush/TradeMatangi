/**
 * Trading cost in option points (spec 4.4). The settings are the player's and are placeholders until they enter their broker's
 * numbers: `slippagePtsPerSide` option points on each side, and `roundTripCostPerLotRs` rupees for a whole lot, which per unit
 * is the same number in option points (rupees per lot divided by the lot size).
 */
export interface CostSettings {
  slippagePtsPerSide: number
  roundTripCostPerLotRs: number
  defaultLots: number
}

/** Placeholders, labelled as such in Settings. */
export const DEFAULT_COST: CostSettings = { slippagePtsPerSide: 0.5, roundTripCostPerLotRs: 40, defaultLots: 1 }

export const COST_LIMITS = {
  slippagePtsPerSide: { min: 0, max: 20 },
  roundTripCostPerLotRs: { min: 0, max: 5000 },
  defaultLots: { min: 1, max: 100 },
} as const

const inRange = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

export function normalizeCost(raw: unknown): CostSettings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const lots = COST_LIMITS.defaultLots
  return {
    slippagePtsPerSide: inRange(input.slippagePtsPerSide, COST_LIMITS.slippagePtsPerSide.min, COST_LIMITS.slippagePtsPerSide.max, DEFAULT_COST.slippagePtsPerSide),
    roundTripCostPerLotRs: inRange(input.roundTripCostPerLotRs, COST_LIMITS.roundTripCostPerLotRs.min, COST_LIMITS.roundTripCostPerLotRs.max, DEFAULT_COST.roundTripCostPerLotRs),
    defaultLots: Math.round(inRange(input.defaultLots, lots.min, lots.max, DEFAULT_COST.defaultLots)),
  }
}

/**
 * Cost of one round trip in option points: `2 * slippage * multiplier + rupees per lot / lot size`. `slippageMultiplier` is the
 * level's difficulty lever (0 at level 1, 1.5 at level 20). A missing or invalid lot size counts the flat part as 0 rather than
 * dividing by nothing.
 */
export function costPoints(settings: CostSettings, lotSize: number | undefined, slippageMultiplier = 1): number {
  const flat = lotSize !== undefined && Number.isFinite(lotSize) && lotSize > 0 ? settings.roundTripCostPerLotRs / lotSize : 0
  return 2 * settings.slippagePtsPerSide * Math.max(0, slippageMultiplier) + flat
}
