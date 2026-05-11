import { useState, useEffect } from 'react'
import { Order, Position } from '../services/api'
import { SessionState } from '../hooks/useSimulation'
import { FundsRatios } from './SettingsModal'

type OrderTypeFull = 'TARGET' | 'LIMIT' | 'STOPLOSS'

interface Props {
  sessionState: SessionState
  currentPrice: number
  openOrders: Order[]
  position: Position
  fundsRatioMode: boolean
  fundsRatios: FundsRatios
  onPlaceOrder: (
    side: 'BUY' | 'SELL',
    orderType: OrderTypeFull,
    price: number,
    quantity: number | null,
    opts: { is_stoploss?: boolean; funds_ratio_pct?: number },
  ) => Promise<void>
  onCancelOrder: (orderId: string) => Promise<void>
}

const QUANTITY_OPTIONS = [1, 2, 3, 5, 10]
const RATIO_LABELS = ['L', 'M', 'H'] as const
type RatioKey = 'l' | 'm' | 'h'

export default function OrderPanel({
  sessionState, currentPrice, openOrders, position,
  fundsRatioMode, fundsRatios, onPlaceOrder, onCancelOrder,
}: Props) {
  const [orderType, setOrderType] = useState<OrderTypeFull>('TARGET')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [ratio, setRatio] = useState<RatioKey>('l')
  const [slQty, setSlQty] = useState(1)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isActive = sessionState === 'running' || sessionState === 'paused'
  const hasPosition = position.side !== 'FLAT'
  const parsedPrice = parseFloat(price)

  // When SL tab selected, lock side to opposite of position and reset quantity
  useEffect(() => {
    if (orderType === 'STOPLOSS') {
      if (position.side === 'LONG') setSide('SELL')
      else if (position.side === 'SHORT') setSide('BUY')
      setSlQty(position.quantity)
    }
  }, [orderType, position.side, position.quantity])

  // If position is closed while SL tab is active, revert to TARGET
  useEffect(() => {
    if (orderType === 'STOPLOSS' && !hasPosition) {
      setOrderType('TARGET')
    }
  }, [hasPosition])

  const autoLimit = orderType === 'TARGET' && !isNaN(parsedPrice)
    ? side === 'BUY'
      ? (parsedPrice * 1.01).toFixed(2)
      : (parsedPrice * 0.99).toFixed(2)
    : null

  const ratioPct = fundsRatios[ratio] / 100

  const handlePlace = async () => {
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      setError(`Enter a valid ${orderType === 'LIMIT' ? 'limit' : 'trigger'} price`)
      return
    }

    if (orderType === 'STOPLOSS') {
      const maxQty = position.quantity
      if (slQty < 1 || slQty > maxQty) {
        setError(`SL quantity must be 1–${maxQty}`)
        return
      }
    }

    setError(null)
    setPlacing(true)
    try {
      if (orderType === 'STOPLOSS') {
        await onPlaceOrder(side, 'STOPLOSS', parsedPrice, slQty, { is_stoploss: true })
      } else if (fundsRatioMode) {
        await onPlaceOrder(side, orderType, parsedPrice, null, { funds_ratio_pct: ratioPct })
      } else {
        await onPlaceOrder(side, orderType, parsedPrice, quantity, {})
      }
      setPrice('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to place order')
    } finally {
      setPlacing(false)
    }
  }

  const btn = (label: string, active: boolean, onClick: () => void, disabled = false, color?: string) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, padding: '4px 0', fontSize: 11, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer', border: 'none',
        background: active ? (color || '#1f3a5f') : '#161b22',
        color: active ? (color ? '#fff' : '#79c0ff') : '#484f58',
        transition: 'background 0.15s',
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 1 }}>
        Orders
      </div>

      {/* TARGET / LIMIT / SL toggle */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
        {btn('TARGET', orderType === 'TARGET', () => { setOrderType('TARGET'); setPrice('') }, !isActive)}
        {btn('LIMIT', orderType === 'LIMIT', () => { setOrderType('LIMIT'); setPrice('') }, !isActive)}
        {btn('SL', orderType === 'STOPLOSS',
          () => { if (hasPosition) { setOrderType('STOPLOSS'); setPrice('') } },
          !isActive || !hasPosition,
          orderType === 'STOPLOSS' ? '#8b2300' : undefined,
        )}
      </div>

      {/* BUY / SELL toggle — locked for SL */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
        {(['BUY', 'SELL'] as const).map(s => (
          <button
            key={s}
            disabled={!isActive || orderType === 'STOPLOSS'}
            onClick={() => setSide(s)}
            style={{
              flex: 1, padding: '5px 0', fontSize: 12, fontWeight: 600,
              cursor: (isActive && orderType !== 'STOPLOSS') ? 'pointer' : 'not-allowed',
              border: 'none',
              background: side === s
                ? s === 'BUY' ? '#1f6feb' : '#da3633'
                : '#161b22',
              color: side === s ? '#fff' : '#8b949e',
              transition: 'background 0.15s',
            }}
          >
            {s}{orderType === 'STOPLOSS' ? ' (SL)' : ''}
          </button>
        ))}
      </div>

      {/* Price input */}
      <div>
        <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>
          {orderType === 'LIMIT' ? 'Limit Price' : 'Trigger / SL Price'}
        </div>
        <input
          type="number"
          value={price}
          onChange={e => setPrice(e.target.value)}
          placeholder={currentPrice > 0 ? currentPrice.toFixed(2) : '0.00'}
          disabled={!isActive}
          style={{
            width: '100%', padding: '5px 8px', background: '#0d1117',
            border: '1px solid #30363d', borderRadius: 6,
            color: '#e6edf3', fontSize: 13, boxSizing: 'border-box',
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
        {orderType === 'STOPLOSS' && (
          <div style={{ fontSize: 10, color: '#f0883e', marginTop: 2 }}>
            Exits at market when price {side === 'SELL' ? '≤' : '≥'} trigger
          </div>
        )}
      </div>

      {/* SL qty OR FundsRatio OR regular quantity */}
      {orderType === 'STOPLOSS' ? (
        <div>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>
            SL Quantity (max {position.quantity})
          </div>
          <input
            type="number"
            value={slQty}
            min={1}
            max={position.quantity}
            onChange={e => setSlQty(Math.min(position.quantity, Math.max(1, parseInt(e.target.value) || 1)))}
            disabled={!isActive}
            style={{
              width: '100%', padding: '5px 8px', background: '#0d1117',
              border: '1px solid #30363d', borderRadius: 6,
              color: '#e6edf3', fontSize: 13, boxSizing: 'border-box',
            }}
          />
        </div>
      ) : fundsRatioMode ? (
        <div>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Capital Ratio</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {RATIO_LABELS.map(lbl => {
              const key = lbl.toLowerCase() as RatioKey
              return (
                <button
                  key={lbl}
                  disabled={!isActive}
                  onClick={() => setRatio(key)}
                  style={{
                    flex: 1, padding: '5px 0', fontSize: 12, fontWeight: 700,
                    borderRadius: 4, cursor: isActive ? 'pointer' : 'not-allowed',
                    border: `1px solid ${ratio === key ? '#388bfd' : '#30363d'}`,
                    background: ratio === key ? '#1f3a5f' : '#161b22',
                    color: ratio === key ? '#79c0ff' : '#8b949e',
                  }}
                >
                  {lbl}
                  <span style={{ fontSize: 10, display: 'block', color: ratio === key ? '#58a6ff' : '#484f58' }}>
                    {fundsRatios[key]}%
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Quantity</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {QUANTITY_OPTIONS.map(q => (
              <button
                key={q}
                disabled={!isActive}
                onClick={() => setQuantity(q)}
                style={{
                  padding: '3px 8px', fontSize: 12, borderRadius: 4,
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
      )}

      {error && <div style={{ fontSize: 11, color: '#f85149' }}>{error}</div>}

      <button
        disabled={!isActive || placing}
        onClick={handlePlace}
        style={{
          padding: '7px 0',
          background: isActive
            ? orderType === 'STOPLOSS'
              ? '#8b2300'
              : side === 'BUY' ? '#1f6feb' : '#da3633'
            : '#21262d',
          color: isActive ? '#fff' : '#8b949e',
          border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600,
          cursor: isActive && !placing ? 'pointer' : 'not-allowed',
        }}
      >
        {placing ? 'Placing…' : orderType === 'STOPLOSS'
          ? `Set SL (${side} @ trigger)`
          : fundsRatioMode
            ? `Place ${side} ${orderType} [${ratio.toUpperCase()} · ${fundsRatios[ratio]}%]`
            : `Place ${side} ${orderType}`}
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
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '4px 8px', background: '#161b22', borderRadius: 6,
                  border: `1px solid ${order.is_stoploss ? '#4a2000' : '#21262d'}`,
                  fontSize: 11,
                }}
              >
                <span style={{
                  padding: '1px 5px', borderRadius: 4,
                  background: order.side === 'BUY' ? '#1f3a5f' : '#3d1a1a',
                  color: order.side === 'BUY' ? '#79c0ff' : '#ff7b72',
                  fontWeight: 600, marginRight: 4,
                }}>
                  {order.side}
                </span>
                <span style={{ color: order.is_stoploss ? '#f0883e' : '#484f58', fontSize: 10, marginRight: 4 }}>
                  {order.is_stoploss ? 'SL' : order.order_type}
                </span>
                <span style={{ color: '#e6edf3', flex: 1 }}>
                  {(order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price).toFixed(2)} × {order.quantity}
                </span>
                <button
                  onClick={() => onCancelOrder(order.order_id)}
                  style={{
                    background: 'none', border: 'none', color: '#8b949e',
                    cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1,
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
