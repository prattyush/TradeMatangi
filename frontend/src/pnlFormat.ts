/** Follow the P&L unit setting; currency remains usable without a capital baseline. */
export function formatPnl(value: number, percentMode: boolean, capital: number): string {
  const percentage = percentMode && Number.isFinite(capital) && capital > 0
  const amount = percentage ? value / capital * 100 : value
  return `${value >= 0 ? '+' : ''}${amount.toFixed(2)}${percentage ? '%' : ''}`
}
