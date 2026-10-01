export type OptionRight = 'CE' | 'PE'

export interface PaperPane {
  id: number
  type: 'equity' | 'options'
  intervalMinutes: number
  right?: OptionRight
  strike?: number
  expiry?: string
}

export interface OpenContract {
  right: OptionRight
  strike: number
  expiry: string
  last_opened_at: number
}

/** Pick one live chart per side. An open position overrides the saved chart. */
export function selectPaperResumePanes<T extends PaperPane>(
  saved: T[], openPositions: OpenContract[],
  streamed: { CE: number | null; PE: number | null; expiry: string | null },
  makePane: (right: OptionRight, strike: number, expiry: string) => T,
): { panes: T[]; chosen: Partial<Record<OptionRight, T>> } {
  const panes = [...saved]
  const chosen: Partial<Record<OptionRight, T>> = {}
  for (const right of ['CE', 'PE'] as const) {
    const existing = panes.filter(p => p.type === 'options' && p.right === right)
    const open = openPositions.filter(p => p.right === right)
      .sort((a, b) => b.last_opened_at - a.last_opened_at || b.strike - a.strike)[0]
    const preferred = existing.find(p => p.strike === streamed[right] && p.expiry === streamed.expiry)
      ?? existing[existing.length - 1]
    const target = open
      ? { ...(preferred ?? makePane(right, open.strike, open.expiry)), right, strike: open.strike, expiry: open.expiry } as T
      : preferred && streamed[right] != null && streamed.expiry
        ? { ...preferred, strike: streamed[right], expiry: streamed.expiry } as T
        : preferred
    const firstIndex = panes.findIndex(p => p.type === 'options' && p.right === right)
    for (let i = panes.length - 1; i >= 0; i--) {
      if (panes[i].type === 'options' && panes[i].right === right) panes.splice(i, 1)
    }
    if (target) {
      panes.splice(firstIndex >= 0 ? firstIndex : panes.length, 0, target)
      chosen[right] = target
    }
  }
  return { panes, chosen }
}
