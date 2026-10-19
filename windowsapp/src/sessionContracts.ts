import type { DesktopTradingSnapshot } from './contracts'

export interface OptionIdentity { symbol: string; expiry: string; strike: number; right: string }
export function optionKey(item: OptionIdentity): string {
  return `${item.symbol}:${item.expiry}:${item.strike}:${item.right}`
}
export function requiredContracts(snapshot: DesktopTradingSnapshot): OptionIdentity[] {
  const contracts = new Map<string, OptionIdentity>()
  for (const item of snapshot.contracts) {
    if ((snapshot.positions_by_contract[item.contract_key]?.quantity ?? 0) > 0) contracts.set(optionKey(item), item)
  }
  for (const order of snapshot.open_orders) {
    if (order.right && order.strike && order.expiry) {
      const item = { symbol: order.symbol, expiry: order.expiry, strike: order.strike, right: order.right }
      contracts.set(optionKey(item), item)
    }
  }
  return [...contracts.values()]
}

export function primaryLinkedScreen<T extends { id: string; saved?: { linked_group_id?: string; linked_primary_id?: string } }>(current: T, screens: T[]): string {
  const group = current.saved?.linked_group_id
  if (!group) return current.id
  const members = screens.filter(screen => screen.saved?.linked_group_id === group)
  return members.find(screen => screen.id === current.saved?.linked_primary_id)?.id ?? members[0]?.id ?? current.id
}
