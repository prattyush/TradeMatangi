import { useState } from 'react'
import { Order } from '../services/api'
import { SessionState } from '../hooks/useSimulation'

interface Props {
  sessionState: SessionState
  currentPrice: number
  openOrders: Order[]
  onPlaceOrder: (side: 'BUY' | 'SELL', orderType: 'TARGET' | 'LIMIT', price: number, quantity: number) => Promise<void>
  onCancelOrder: (orderId: string) => Promise<void>
}

const QUANTITY_OPTIONS = [1, 2, 3, 5, 10]

export default function OrderPanel({ sessionState, currentPrice, openOrders, onPlaceOrder, onCancelOrder }: Props) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [orderType, setOrderType] = useState<'TARGET' | 'LIMIT'>('TARGET')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isActive = sessionState === 'running' || sessionState === 'paused'
  const parsedPrice = parseFloat(price)

  const autoLimit = orderType === 'TARGET' && !isNaN(parsedPrice)
    ? side === 'BUY'
      ? (parsedPrice * 1.01).toFixed(2)
      : (parsedPrice * 0.99).toFixed(2)
    : null

  const handlePlace = async () => {
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      setError(`Enter a valid ${orderType === 'TARGET' ? 'trigger' : 'limit'} price`)
      return
    }
    setError(null)
    setPlacing(true)
    try {
      await onPlaceOrder(side, orderType, parsedPrice, quantity)
      setPrice('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to place order')
    } finally {
      setPlacing(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 1 }}>
        Orders
      </div>

      {/* TARGET / LIMIT order type toggle */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
        {(['TARGET', 'LIMIT'] as const).map(t => (
          <button
            key={t}
            disabled={!isActive}
            onClick={() => { setOrderType(t); setPrice('') }}
            style={{
              flex: 1,
              padding: '4px 0',
              fontSize: 11,
              fontWeight: 600,
              cursor: isActive ? 'pointer' : 'not-allowed',
              border: 'none',
              background: orderType === t ? '#1f3a5f' : '#161b22',
              color: orderType === t ? '#79c0ff' : '#484f58',
              transition: 'background 0.15s',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* BUY / SELL toggle */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
        {(['BUY', 'SELL'] as const).map(s => (
          <button
            key={s}
            disabled={!isActive}
            onClick={() => setSide(s)}
            style={{
              flex: 1,
              padding: '5px 0',
              fontSize: 12,
              fontWeight: 600,
              cursor: isActive ? 'pointer' : 'not-allowed',
              border: 'none',
              background: side === s
                ? s === 'BUY' ? '#1f6feb' : '#da3633'
                : '#161b22',
              color: side === s ? '#fff' : '#8b949e',
              transition: 'background 0.15s',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Price input */}
      <div>
        <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>
          {orderType === 'TARGET' ? 'Trigger Price' : 'Limit Price'}
        </div>
        <input
          type="number"
          value={price}
          onChange={e => setPrice(e.target.value)}
          placeholder={currentPrice > 0 ? currentPrice.toFixed(2) : '0.00'}
          disabled={!isActive}
          style={{
            width: '100%',
            padding: '5px 8px',
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: 6,
            color: '#e6edf3',
            fontSize: 13,
            boxSizing: 'border-box',
          }}
        />
        {orderType === 'TARGET' && (
          <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>
            Exec limit: {autoLimit ?? '—'} (±1%)
          </div>
        )}
        {orderType === 'LIMIT' && (
          <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>
            Fills when price {side === 'BUY' ? '≤' : '≥'} {isNaN(parsedPrice) ? '—' : parsedPrice.toFixed(2)}
          </div>
        )}
      </div>

      {/* Quantity */}
      <div>
        <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Quantity</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {QUANTITY_OPTIONS.map(q => (
            <button
              key={q}
              disabled={!isActive}
              onClick={() => setQuantity(q)}
              style={{
                padding: '3px 8px',
                fontSize: 12,
                borderRadius: 4,
                border: `1px solid ${quantity === q ? '#388bfd' : '#30363d'}`,
                background: quantity === q ? '#1f3a5f' : '#161b22',
                color: quantity === q ? '#79c0ff' : '#8b949e',
                cursor: isActive ? 'pointer' : 'not-allowed',
              }}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {error && <div style={{ fontSize: 11, color: '#f85149' }}>{error}</div>}

      <button
        disabled={!isActive || placing}
        onClick={handlePlace}
        style={{
          padding: '7px 0',
          background: isActive ? (side === 'BUY' ? '#1f6feb' : '#da3633') : '#21262d',
          color: isActive ? '#fff' : '#8b949e',
          border: 'none',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          cursor: isActive && !placing ? 'pointer' : 'not-allowed',
        }}
      >
        {placing ? 'Placing…' : `Place ${side} ${orderType}`}
      </button>

      {/* Open orders */}
      {openOrders.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Open Orders ({openOrders.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {openOrders.map(order => (
              <div
                key={order.order_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 8px',
                  background: '#161b22',
                  borderRadius: 6,
                  border: '1px solid #21262d',
                  fontSize: 11,
                }}
              >
                <span style={{
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: order.side === 'BUY' ? '#1f3a5f' : '#3d1a1a',
                  color: order.side === 'BUY' ? '#79c0ff' : '#ff7b72',
                  fontWeight: 600,
                  marginRight: 4,
                }}>
                  {order.side}
                </span>
                <span style={{ color: '#484f58', fontSize: 10, marginRight: 4 }}>
                  {order.order_type}
                </span>
                <span style={{ color: '#e6edf3', flex: 1 }}>
                  {(order.order_type === 'TARGET' ? order.trigger_price : order.limit_price).toFixed(2)} × {order.quantity}
                </span>
                <button
                  onClick={() => onCancelOrder(order.order_id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#8b949e',
                    cursor: 'pointer',
                    fontSize: 13,
                    padding: '0 2px',
                    lineHeight: 1,
                  }}
                  title="Cancel order"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
