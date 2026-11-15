/** One edited leg of a saved what-if: the new price and quantity of an entry or exit (quantity 0 removes the leg). */
export interface WhatIfEdit {
  /** The round trip number (its label index). */
  round_trip: number
  /** The execution (or trade) id of the real leg that is edited. */
  leg_id: string
  role: 'entry' | 'exit'
  price: number
  quantity: number
}

/** The result of a what-if, kept with the scenario so a list of them needs no recalculation. */
export interface WhatIfSummary {
  actual_pnl: number
  whatif_pnl: number
  delta: number
  delta_pct: number | null
  trips_edited: number
  warnings: number
}

export interface WhatIfScenario {
  session_id: string
  scenario_id: string
  name: string
  date: string
  symbol: string
  session_type: string
  instrument_type: string
  summary: WhatIfSummary
  version: number
  updated_at: string
  /** Absent in the date-range list (summaries only). */
  edits?: WhatIfEdit[]
}

/**
 * Saved what-ifs, owned by the signed-in user. Analysis offers saving only when the host gives it this (website, desktop
 * and phone do); without it What If still works as a playground that is lost on refresh.
 */
export interface WhatIfSource {
  list(sessionId: string): Promise<WhatIfScenario[]>
  /** Scenarios over a date range (summaries, no edits), oldest day first: the Compare days view. */
  range(start?: string, end?: string): Promise<WhatIfScenario[]>
  /** Saves a scenario of that name for the day, replacing one with the same name. */
  save(scenario: { sessionId: string; name: string; edits: WhatIfEdit[]; summary: WhatIfSummary }): Promise<WhatIfScenario>
  remove(sessionId: string, scenarioId: string): Promise<void>
}
