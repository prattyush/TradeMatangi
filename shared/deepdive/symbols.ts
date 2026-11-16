/**
 * The symbols the Pattern Library works with, shown in the Deep Dive's symbol dropdown. Same list as the website's Pattern
 * Library page (`SUPPORTED_SYMBOLS` in `frontend/src/pages/PatternLibrary.tsx`; a test keeps the two equal). Each has option
 * chains and a strike gap in the backend, so every one gets an option chart; Max Price strikes are for the two indices only,
 * the stocks use OTM strikes (`patternStrikeRule`).
 */
export const PATTERN_SYMBOLS: ReadonlyArray<{ symbol: string; name: string }> = [
  { symbol: 'NIFTY', name: 'NIFTY 50' },
  { symbol: 'BSESEN', name: 'SENSEX' },
  { symbol: 'RELIND', name: 'Reliance Industries' },
  { symbol: 'TATMOT', name: 'Tata Motors CV' },
  { symbol: 'TATPOW', name: 'Tata Power' },
]

/** The dropdown entries: the Pattern symbols, plus the current symbol when a saved deep dive uses another one. */
export function symbolChoices(current: string): Array<{ symbol: string; label: string }> {
  const choices = PATTERN_SYMBOLS.map(({ symbol, name }) => ({ symbol, label: name === symbol ? symbol : `${name} (${symbol})` }))
  return !current || choices.some(choice => choice.symbol === current) ? choices : [...choices, { symbol: current, label: current }]
}
