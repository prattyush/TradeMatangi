/** Chart gestures must keep their original instrument and price domain. */
export interface ChartContract {
  type: string;
  right?: string | null;
  strike?: number | null;
  expiry?: string | null;
}
export const underlyingOptionsChart = (pane: ChartContract, instrumentType: string) =>
  pane.type === 'equity' && instrumentType === 'options';

export function matchesChartContract(order: {right?: string | null; strike?: number | null; expiry?: string | null}, pane: ChartContract): boolean {
  return pane.type === 'options'
    ? order.right === pane.right && order.strike === pane.strike && order.expiry === pane.expiry
    : !order.right;
}

export function chartEntryError(pane: ChartContract, session: {instrumentType: string; sessionType: string; strikeCE: number | null; strikePE: number | null; expiry: string | null}): string | null {
  if (underlyingOptionsChart(pane, session.instrumentType)) return 'Place option orders on a CE/PE chart';
  if (pane.type === 'options') {
    if (!['CE', 'PE'].includes(pane.right ?? '') || !pane.strike || !pane.expiry) return 'Select an exact CE/PE contract before placing an order';
    if (session.sessionType !== 'real' && (pane.strike !== (pane.right === 'CE' ? session.strikeCE : session.strikePE) || pane.expiry !== session.expiry)) return 'Select an actively streamed option contract before placing an order';
  }
  return null;
}

export function chartMarketPrice(right: string | null | undefined, quotes: {equity: number; ce: number; pe: number}): number {
  const price = right === 'CE' ? quotes.ce : right === 'PE' ? quotes.pe : quotes.equity;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Waiting for a valid quote for this contract');
  return price;
}

/** Stop at the first failure; earlier acknowledgments have already been applied. */
export async function runChartOrderBatch<T>(orders: T[], write: (order: T) => Promise<unknown>): Promise<void> {
  let completed = 0;
  try { for (const order of orders) { await write(order); completed++; } }
  catch (error) { throw new Error(`${completed} of ${orders.length} orders updated. Stopped: ${error instanceof Error ? error.message : String(error)}`); }
}
