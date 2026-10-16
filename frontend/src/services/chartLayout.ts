/** KLine's supplied height already includes its controls; Lightweight has a separate toolbar. */
export function chartPaneHeight(available: number, renderer: 'kline' | 'lightweight', rows: 1 | 2, gap = 4): number {
  const toolbar = renderer === 'kline' ? 0 : 32;
  return Math.max(160, Math.floor((available - toolbar * rows - gap * (rows - 1)) / rows));
}
