/** Use the same contract tick for drag, pick and quote shortcuts. */
export function swingOrderTick(order: any): number {
  const tick = Number(order.analytics?.futures?.contract?.tick_size ?? order.tick_size ?? .05)
  return Number.isFinite(tick) && tick > 0 ? tick : .05
}
export function snapSwingPrice(price: number, tick = .05): number {
  return Number((Math.round((price + Number.EPSILON) / tick) * tick).toFixed(8))
}
