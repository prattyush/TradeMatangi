import { shiftTradingDay, type OptionRight } from '../../../shared/browse/browseModel.ts'

/**
 * The website's Browse workspace: panes that each have their own symbol, date and contract, in the same layouts the
 * trading screen offers. Pure (no React, no browser globals): the component keeps it in browser storage per user.
 */

export type LayoutPreset = 1 | 2 | 3 | 4 | 5 | 6 | 7
export const LAYOUT_PRESETS: LayoutPreset[] = [1, 2, 3, 4, 5, 6, 7]
export const LAYOUT_LABEL: Record<LayoutPreset, string> = {
  1: '1 pane', 2: '2 panes', 3: '3 panes', 4: '4 panes', 5: '5 equal', 6: '5 wide right', 7: '4 (1 + 3)',
}
export const LAYOUT_PANE_COUNT: Record<LayoutPreset, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 5, 7: 4 }

export interface BrowsePane {
  id: number
  symbol: string
  /** The underlying itself, or one of its option contracts. */
  kind: 'spot' | OptionRight
  /** The pane's own trading day. */
  date: string
  expiry: string | null
  strike: number | null
  /** How an option's strike is chosen: by hand, or the first strike at or below a premium cap. */
  pick: { mode: 'manual' | 'max_price'; cap: number | null }
  /** The candle interval in minutes the pane was left at. */
  interval: number
}

export interface BrowseState {
  layout: LayoutPreset
  panes: BrowsePane[]
  maximized: number | null
}

/** Rows of pane indexes with the share of the width each takes, as the trading screen lays out its presets. */
export function layoutRows(layout: LayoutPreset): Array<{ panes: number[]; flex: number[] }> {
  const equal = (...indexes: number[]) => ({ panes: indexes, flex: indexes.map(() => 1) })
  switch (layout) {
    case 1: return [equal(0)]
    case 2: return [equal(0), equal(1)]
    case 3: return [equal(0), equal(1, 2)]
    case 4: return [equal(0, 1), equal(2, 3)]
    case 5: return [equal(0, 1, 2), equal(3, 4)]
    case 6: return [{ panes: [0, 1, 2], flex: [1, 0.5, 0.5] }, equal(3, 4)]
    case 7: return [equal(0), equal(1, 2, 3)]
  }
}

export const isLayoutPreset = (value: unknown): value is LayoutPreset => LAYOUT_PRESETS.includes(value as LayoutPreset)

const DEFAULT_SYMBOLS = ['NIFTY', 'BSESEN', 'RELIND', 'TATMOT', 'TATPOW']

export function newPane(id: number, symbol: string, date: string): BrowsePane {
  return { id, symbol, kind: 'spot', date, expiry: null, strike: null, pick: { mode: 'manual', cap: null }, interval: 3 }
}

/** The first Browse: two panes, NIFTY and SENSEX, on the last completed day. */
export function defaultState(date: string): BrowseState {
  return { layout: 2, panes: [newPane(1, DEFAULT_SYMBOLS[0], date), newPane(2, DEFAULT_SYMBOLS[1], date)], maximized: null }
}

/** Switch layout: keep the panes that still fit, add new ones (the next symbols, the same day) for the rest. */
export function withLayout(state: BrowseState, layout: LayoutPreset): BrowseState {
  const wanted = LAYOUT_PANE_COUNT[layout]
  const panes = state.panes.slice(0, wanted)
  let nextId = Math.max(0, ...state.panes.map(pane => pane.id)) + 1
  const date = state.panes[0]?.date ?? ''
  while (panes.length < wanted) {
    const unused = DEFAULT_SYMBOLS.find(symbol => !panes.some(pane => pane.symbol === symbol)) ?? DEFAULT_SYMBOLS[panes.length % DEFAULT_SYMBOLS.length]
    panes.push(newPane(nextId++, unused, date))
  }
  return { layout, panes, maximized: panes.some(pane => pane.id === state.maximized) ? state.maximized : null }
}

export function updatePane(state: BrowseState, id: number, patch: Partial<BrowsePane>): BrowseState {
  return { ...state, panes: state.panes.map(pane => (pane.id === id ? { ...pane, ...patch } : pane)) }
}

/** Another symbol resets what only made sense for the old one (the contract); the day and interval stay. */
export function withSymbol(pane: BrowsePane, symbol: string): BrowsePane {
  return { ...pane, symbol, kind: 'spot', expiry: null, strike: null, pick: { mode: 'manual', cap: null } }
}

/** Another day moves the contract with it: the strike is chosen again for that day's expiry. */
export function withDate(pane: BrowsePane, date: string): BrowsePane {
  return { ...pane, date, expiry: null, strike: pane.pick.mode === 'max_price' ? null : pane.strike }
}

export function stepPaneDate(pane: BrowsePane, direction: 1 | -1, latest: string): BrowsePane {
  const next = shiftTradingDay(pane.date, direction)
  return next > latest ? pane : withDate(pane, next)
}

/** What the pane's button says: "NIFTY · Mon 9 Nov · CE 24500". */
export function paneTitle(pane: BrowsePane, formatDate: (iso: string) => string): string {
  const contract = pane.kind === 'spot' ? '' : ` · ${pane.kind}${pane.strike ? ` ${pane.strike}` : pane.pick.mode === 'max_price' && pane.pick.cap ? ` ≤${pane.pick.cap}` : ''}`
  return `${pane.symbol} · ${formatDate(pane.date)}${contract}`
}

export const storageKey = (userId: string) => `tradematangi_browse_${userId}`

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** Read saved Browse state; anything malformed falls back to the default instead of breaking the page. */
export function parseState(raw: string | null, fallbackDate: string): BrowseState {
  if (!raw) return defaultState(fallbackDate)
  try {
    const parsed = JSON.parse(raw) as Partial<BrowseState> | null
    if (!parsed || typeof parsed !== 'object' || !isLayoutPreset(parsed.layout) || !Array.isArray(parsed.panes)) return defaultState(fallbackDate)
    const panes: BrowsePane[] = []
    for (const item of parsed.panes as unknown as Array<Record<string, unknown>>) {
      const id = num(item?.id)
      const symbol = text(item?.symbol)
      const date = text(item?.date)
      if (id === null || !symbol || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || panes.some(pane => pane.id === id)) continue
      const kind = item.kind === 'CE' || item.kind === 'PE' ? item.kind : 'spot'
      const pick = item.pick as { mode?: unknown; cap?: unknown } | undefined
      const interval = num(item.interval)
      panes.push({
        id, symbol, kind, date,
        expiry: kind === 'spot' ? null : text(item.expiry),
        strike: kind === 'spot' ? null : num(item.strike),
        pick: { mode: pick?.mode === 'max_price' ? 'max_price' : 'manual', cap: num(pick?.cap) },
        interval: interval && [1, 3, 5, 10, 15, 30, 60].includes(interval) ? interval : 3,
      })
    }
    if (!panes.length) return defaultState(fallbackDate)
    return withLayout({ layout: parsed.layout, panes, maximized: num(parsed.maximized) }, parsed.layout)
  } catch {
    return defaultState(fallbackDate)
  }
}

/** A month as weeks of ISO dates, Monday first; days outside the month are null. */
export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const first = new Date(Date.UTC(year, month, 1))
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const lead = (first.getUTCDay() + 6) % 7
  const cells: Array<string | null> = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(Date.UTC(year, month, i + 1)).toISOString().slice(0, 10))]
  while (cells.length % 7) cells.push(null)
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7))
}

/** The month `delta` months from (year, month); month is 0 to 11. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + month + delta
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 }
}

/** A day the calendar offers: a weekday, not after `latest`. (Exchange holidays are answered by the server, as everywhere in Browse.) */
export function pickableDay(iso: string, latest: string): boolean {
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6 && iso <= latest
}
