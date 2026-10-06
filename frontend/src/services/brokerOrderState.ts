import type { Order } from './api'

// Conversion request responses can arrive after their confirmation SSE event.
export function confirmedOrderUpdate(current: Order | undefined, incoming: Order): Order {
  if (!current) return incoming
  const before = current.broker_conversion?.updated_at ?? 0
  const after = incoming.broker_conversion?.updated_at ?? 0
  if (before > after) return current
  if (current.status !== 'PENDING' && incoming.status === 'PENDING') return current
  return incoming
}

export function mergeOpenOrders(current: Order[], incoming: Order[], replace = false): Order[] {
  const existing = new Map(current.map(order => [order.order_id, order]))
  const merged = replace ? new Map<string, Order>() : new Map(existing)
  for (const order of incoming) merged.set(order.order_id, confirmedOrderUpdate(existing.get(order.order_id), order))
  return [...merged.values()].filter(order => order.status === 'PENDING')
}
