/**
 * The rule used to pick CE/PE strikes when a session starts, remembered so the
 * per-pane "Re-select strike" button can re-apply it at the current price.
 */
export interface StrikeRule {
  mode: 'otm' | 'max_price'
  otmOffset: number
  maxPriceCE?: number
  maxPricePE?: number
}

export interface ReselectBody {
  right: 'CE' | 'PE'
  mode: 'otm' | 'max_price'
  otm_offset?: number
  max_price?: number
}

export interface StrikeRuleFallback {
  /** localStorage `maxPriceMode` ('otm' | 'threshold' | null) */
  storedMode: string | null
  storedThresholdCE: number | null
  storedThresholdPE: number | null
  /** OTM offset currently shown in the "Add" row */
  offset: number
  /** Max Price applies to indices only (NIFTY / BSESEN) */
  isIndex: boolean
}

export function strikeRuleFromStart(
  isIndex: boolean, storedMode: string | null, otmOffset: number,
  thresholdCE: number, thresholdPE: number,
): StrikeRule {
  if (isIndex && storedMode === 'threshold') {
    return { mode: 'max_price', otmOffset, maxPriceCE: thresholdCE, maxPricePE: thresholdPE }
  }
  return { mode: 'otm', otmOffset }
}

/** Build the request body for one side. Uses the start-time rule when known,
 *  otherwise the user's current settings (e.g. a resumed / re-attached session). */
export function buildReselectBody(
  right: 'CE' | 'PE', rule: StrikeRule | null, fallback: StrikeRuleFallback,
): ReselectBody {
  const effective: StrikeRule = rule ?? strikeRuleFromStart(
    fallback.isIndex, fallback.storedMode, fallback.offset,
    fallback.storedThresholdCE ?? 50, fallback.storedThresholdPE ?? 50,
  )
  if (effective.mode === 'max_price') {
    const cap = right === 'CE' ? effective.maxPriceCE : effective.maxPricePE
    if (cap != null && cap > 0) return { right, mode: 'max_price', max_price: cap }
  }
  return { right, mode: 'otm', otm_offset: effective.otmOffset }
}
