import { useState, useEffect } from 'react'
import { Order, Position } from '../services/api'
import { SessionState } from '../hooks/useSimulation'
import { FundsRatios } from './SettingsModal'

type OrderTypeFull = 'TARGET' | 'LIMIT' | 'STOPLOSS' | 'MARKET'

interface Props {
  sessionState: SessionState
  currentPrice: number
  openOrders: Order[]
  position: Position
  fundsRatioMode: boolean
  fundsRatios: FundsRatios
  targetDeviationPct: number   // fraction e.g. 0.01 for 1%
  onPlaceOrder: (
    side: 'BUY' | 'SELL',
    orderType: 'TARGET' | 'LIMIT' | 'STOPLOSS',
    price: number,
    quantity: number | null,
    opts: { is_stoploss?: boolean; funds_ratio_pct?: number; target_deviation_pct?: number },
  ) => Promise<void>
  onCancelOrder: (orderId: string) => Promise<void>
  onUpdateOrder: (orderId: string, triggerPrice?: number, limitPrice?: number) => Promise<void>
  // Price-pick from chart
  onRequestPricePick: (orderId: string) => void
  injectedEditPrice: { orderId: string; price: number } | null
}

const QUANTITY_OPTIONS = [1, 2, 3, 5, 10]
const RATIO_LABELS = ['L', 'M', 'H'] as const
type RatioKey = 'l' | 'm' | 'h'

export default function OrderPanel({
  sessionState, currentPrice, openOrders, position,
  fundsRatioMode, fundsRatios, targetDeviationPct,
  onPlaceOrder, onCancelOrder, onUpdateOrder,
  onRequestPricePick, injectedEditPrice,
}: Props) {
  const [orderType, setOrderType] = useState<OrderTypeFull>('TARGET')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [ratio, setRatio] = useState<RatioKey>('l')
  const [slQty, setSlQty] = useState(1)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Inline edit state
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [updating, setUpdating] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const isActive = sessionState === 'running' || sessionState === 'paused'
  const hasPosition = position.side !== 'FLAT'
  const parsedPrice = parseFloat(price)
  const deviation = targetDeviationPct  // fraction

  // When SL tab selected, lock side to opposite of position
  useEffect(() => {
    if (orderType === 'STOPLOSS') {
      if (position.side === 'LONG') setSide('SELL')
      else if (position.side === 'SHORT') setSide('BUY')
      setSlQty(position.quantity)
    }
  }, [orderType, position.side, position.quantity])

  useEffect(() => {
    if (orderType === 'STOPLOSS' && !hasPosition) setOrderType('TARGET')
  }, [hasPosition])

  // Inject chart-picked price into the placement field
  useEffect(() => {
    if (injectedEditPrice && injectedEditPrice.orderId === '__new__') {
      setPrice(injectedEditPrice.price.toFixed(2))
    }
  }, [injectedEditPrice])

  // Inject chart-picked price into the edit field
  useEffect(() => {
    if (injectedEditPrice && injectedEditPrice.orderId === editingOrderId) {
      setEditPrice(injectedEditPrice.price.toFixed(2))
    }
  }, [injectedEditPrice])

  const autoLimit = orderType === 'TARGET' && !isNaN(parsedPrice)
    ? side === 'BUY'
      ? (parsedPrice * (1 + deviation)).toFixed(2)
      : (parsedPrice * (1 - deviation)).toFixed(2)
    : null

  const ratioPct = fundsRatios[ratio] / 100

  const handlePlace = async () => {
    if (orderType === 'MARKET') {
      if (currentPrice <= 0) {
        setError('Waiting for price data')
        return
      }
    } else if (isNaN(parsedPrice) || parsedPrice <= 0) {
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
      if (orderType === 'MARKET') {
        // 1% deviation ensures immediate fill: BUY limit above market, SELL limit below
        const mktPrice = side === 'BUY' ? currentPrice * 1.01 : currentPrice * 0.99
        await onPlaceOrder(side, 'LIMIT', mktPrice, null, { funds_ratio_pct: ratioPct })
      } else if (orderType === 'STOPLOSS') {
        await onPlaceOrder(side, 'STOPLOSS', parsedPrice, slQty, { is_stoploss: true })
      } else if (fundsRatioMode) {
        await onPlaceOrder(side, orderType, parsedPrice, null, {
          funds_ratio_pct: ratioPct,
          target_deviation_pct: deviation,
        })
      } else {
        await onPlaceOrder(side, orderType, parsedPrice, quantity, { target_deviation_pct: deviation })
      }
      setPrice('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to place order')
    } finally {
      setPlacing(false)
    }
  }

  const startEdit = (order: Order) => {
    const currentVal = order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price
    setEditingOrderId(order.order_id)
    setEditPrice(currentVal.toFixed(2))
    setEditError(null)
  }

  const cancelEdit = () => {
    setEditingOrderId(null)
    setEditPrice('')
    setEditError(null)
  }

  const saveEdit = async (order: Order) => {
    const p = parseFloat(editPrice)
    if (isNaN(p) || p <= 0) {
      setEditError('Enter a valid price')
      return
    }
    setUpdating(true)
    setEditError(null)
    try {
      if (order.order_type === 'LIMIT') {
        await onUpdateOrder(order.order_id, undefined, p)
      } else {
        await onUpdateOrder(order.order_id, p, undefined)
      }
      setEditingOrderId(null)
      setEditPrice('')
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setUpdating(false)
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

  // L/M/H ratio picker used for Mkt and fundsRatioMode
  const ratioButtons = (
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
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 1 }}>
        Orders
      </div>

      {/* Tgt / Lmt / SL / Mkt toggle */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
        {btn('Tgt', orderType === 'TARGET', () => { setOrderType('TARGET'); setPrice('') }, !isActive)}
        {btn('Lmt', orderType === 'LIMIT', () => { setOrderType('LIMIT'); setPrice('') }, !isActive)}
        {btn('SL', orderType === 'STOPLOSS',
          () => { if (hasPosition) { setOrderType('STOPLOSS'); setPrice('') } },
          !isActive || !hasPosition,
          orderType === 'STOPLOSS' ? '#8b2300' : undefined,
        )}
        {btn('Mkt', orderType === 'MARKET', () => { setOrderType('MARKET'); setPrice('') }, !isActive)}
      </div>

      {/* BUY / SELL toggle */}
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
              background: side === s ? (s === 'BUY' ? '#1f6feb' : '#da3633') : '#161b22',
              color: side === s ? '#fff' : '#8b949e',
              transition: 'background 0.15s',
            }}
          >
            {s}{orderType === 'STOPLOSS' ? ' (SL)' : ''}
          </button>
        ))}
      </div>

      {/* Price input — hidden for Market orders */}
      {orderType !== 'MARKET' && (
        <div>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>
            {orderType === 'LIMIT' ? 'Limit Price' : 'Trigger / SL Price'}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="number"
            value={price}
            onChange={e => setPrice(e.target.value)}
            placeholder={currentPrice > 0 ? currentPrice.toFixed(2) : '0.00'}
            disabled={!isActive}
            style={{
              flex: 1, padding: '5px 8px', background: '#0d1117',
              border: '1px solid #30363d', borderRadius: 6,
              color: '#e6edf3', fontSize: 13, boxSizing: 'border-box',
            }}
          />
          <button
            onClick={() => onRequestPricePick('__new__')}
            disabled={!isActive}
            title="Pick price from chart"
            style={{
              padding: '4px 7px', background: '#21262d',
              border: '1px solid #30363d', borderRadius: 6,
              color: isActive ? '#8b949e' : '#484f58',
              cursor: isActive ? 'pointer' : 'not-allowed', fontSize: 11,
            }}
          >⊕</button>
          </div>
          {orderType === 'TARGET' && (
            <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>
              Exec limit: {autoLimit ?? '—'} (±{(deviation * 100).toFixed(1)}%)
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
      )}

      {/* Market info hint */}
      {orderType === 'MARKET' && (
        <div style={{ fontSize: 10, color: '#484f58' }}>
          {currentPrice > 0
            ? `Limit ${side === 'BUY' ? '≤' : '≥'} ${(side === 'BUY' ? currentPrice * 1.01 : currentPrice * 0.99).toFixed(2)} (1% ${side === 'BUY' ? 'above' : 'below'} ${currentPrice.toFixed(2)})`
            : 'Waiting for price data…'}
        </div>
      )}

      {/* Quantity / FundsRatio / SL qty */}
      {orderType === 'MARKET' ? (
        <div>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Capital Ratio</div>
          {ratioButtons}
        </div>
      ) : orderType === 'STOPLOSS' ? (
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
          {ratioButtons}
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
            ? orderType === 'STOPLOSS' ? '#8b2300'
            : side === 'BUY' ? '#1f6feb' : '#da3633'
            : '#21262d',
          color: isActive ? '#fff' : '#8b949e',
          border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600,
          cursor: isActive && !placing ? 'pointer' : 'not-allowed',
        }}
      >
        {placing ? 'Placing…'
          : orderType === 'STOPLOSS' ? `Set SL (${side} @ trigger)`
          : orderType === 'MARKET' ? `${side} Mkt [${ratio.toUpperCase()} · ${fundsRatios[ratio]}%]`
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
            {openOrders.map(order => {
              const isEditing = editingOrderId === order.order_id
              const displayPrice = order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price

              return (
                <div
                  key={order.order_id}
                  style={{
                    background: '#161b22', borderRadius: 6,
                    border: `1px solid ${order.is_stoploss ? '#4a2000' : isEditing ? '#388bfd' : '#21262d'}`,
                    fontSize: 11,
                    overflow: 'hidden',
                  }}
                >
                  {/* Order summary row */}
                  <div
                    style={{
                      display: 'flex', alignItems: 'center',
                      padding: '4px 8px', cursor: isActive ? 'pointer' : 'default',
                      gap: 4,
                    }}
                    onClick={() => isActive && !isEditing && startEdit(order)}
                    title={isActive ? 'Click to edit price' : undefined}
                  >
                    <span style={{
                      padding: '1px 5px', borderRadius: 4,
                      background: order.side === 'BUY' ? '#1f3a5f' : '#3d1a1a',
                      color: order.side === 'BUY' ? '#79c0ff' : '#ff7b72',
                      fontWeight: 600,
                    }}>
                      {order.side}
                    </span>
                    <span style={{ color: order.is_stoploss ? '#f0883e' : '#484f58', fontSize: 10 }}>
                      {order.is_stoploss ? 'SL' : order.order_type}
                    </span>
                    <span style={{ color: '#e6edf3', flex: 1 }}>
                      {displayPrice.toFixed(2)} × {order.quantity}
                    </span>
                    {isActive && !isEditing && (
                      <span style={{ color: '#484f58', fontSize: 10, marginRight: 2 }} title="Edit">✎</span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onCancelOrder(order.order_id) }}
                      style={{
                        background: 'none', border: 'none', color: '#8b949e',
                        cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1,
                      }}
                      title="Cancel order"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Inline edit row */}
                  {isEditing && (
                    <div style={{ padding: '6px 8px', borderTop: '1px solid #21262d', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 10, color: '#8b949e' }}>
                        {order.order_type === 'LIMIT' ? 'New limit price' : 'New trigger price'}
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          type="number"
                          value={editPrice}
                          step={0.5}
                          onChange={e => setEditPrice(e.target.value)}
                          autoFocus
                          style={{
                            flex: 1, padding: '4px 6px', background: '#0d1117',
                            border: '1px solid #388bfd', borderRadius: 4,
                            color: '#e6edf3', fontSize: 12,
                          }}
                        />
                        <button
                          onClick={() => onRequestPricePick(order.order_id)}
                          title="Pick price from chart"
                          style={{
                            padding: '4px 7px', background: '#21262d',
                            border: '1px solid #30363d', borderRadius: 4,
                            color: '#8b949e', cursor: 'pointer', fontSize: 11,
                          }}
                        >
                          ⊕
                        </button>
                      </div>
                      {order.order_type === 'TARGET' && editPrice && !isNaN(parseFloat(editPrice)) && (
                        <div style={{ fontSize: 10, color: '#484f58' }}>
                          New limit: {
                            order.side === 'BUY'
                              ? (parseFloat(editPrice) * (1 + deviation)).toFixed(2)
                              : (parseFloat(editPrice) * (1 - deviation)).toFixed(2)
                          } (±{(deviation * 100).toFixed(1)}%)
                        </div>
                      )}
                      {editError && <div style={{ fontSize: 10, color: '#f85149' }}>{editError}</div>}
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => saveEdit(order)}
                          disabled={updating}
                          style={{
                            flex: 1, padding: '4px 0', background: '#1f6feb',
                            border: 'none', borderRadius: 4, color: '#fff',
                            cursor: updating ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
                          }}
                        >
                          {updating ? '…' : 'Save'}
                        </button>
                        <button
                          onClick={cancelEdit}
                          style={{
                            flex: 1, padding: '4px 0', background: '#21262d',
                            border: '1px solid #30363d', borderRadius: 4, color: '#8b949e',
                            cursor: 'pointer', fontSize: 11,
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
