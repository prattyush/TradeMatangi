import { useState, useEffect } from 'react'
import { Order, Position, StrategyResponse } from '../services/api'
import { SessionState } from '../hooks/useSimulation'
import { FundsRatios } from './SettingsModal'

type OrderTypeFull = 'TARGET' | 'LIMIT' | 'STOPLOSS' | 'MARKET' | 'STRAT'

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
  onRequestTpPick?: () => void
  injectedTpPrice?: number | null
  // Strategy props
  instrumentType?: 'equity' | 'options'
  activeRight?: 'CE' | 'PE' | null
  positionCE?: Position
  positionPE?: Position
  runningStrategies?: StrategyResponse[]
  autostopTriggerType?: 'bar' | 'deviation'
  autostopDeviationPct?: number
  breakevenMode?: 'shift_sl' | 'limit_order'
  targetProfitBufferTicks?: number
  aggrSlOnlyInProfit?: boolean
  onStartStrategy?: (
    strategyType: 'AutoStop' | 'BreakEven' | 'AggressiveStoploss' | 'TargetProfit' | 'LockProfit' | 'UnderlyingTargetProfit',
    right: 'CE' | 'PE' | null,
    opts: {
      quantity?: number
      fundsRatioPct?: number
      direction?: 'BUY' | 'SELL'
      onlyInProfit?: boolean
      targetProfitValue?: number
      targetProfitIsPct?: boolean
      lockProfitValue?: number
      lockProfitIsPct?: boolean
    }
  ) => Promise<void>
  onCancelAllStrategies?: () => Promise<void>
  onCancelStrategy?: (strategyId: string) => Promise<void>
  onUpdateStrategyPrice?: (strategyId: string, price: number) => Promise<void>
  onBulkUpdateSL?: (triggerPrice: number, right: string | null) => Promise<{ updated: number }>
  onRequestLpPick?: () => void
  injectedLpPrice?: number | null
  onGuardRailBlocked?: (type: 'BLOCK' | 'COOLDOWN' | 'BAN', reason: string) => void
}

const QUANTITY_OPTIONS = [1, 2, 3, 5, 10]
const RATIO_LABELS = ['L', 'M', 'H'] as const
type RatioKey = 'l' | 'm' | 'h'

export default function OrderPanel({
  sessionState, currentPrice, openOrders, position,
  fundsRatioMode, fundsRatios, targetDeviationPct,
  onPlaceOrder, onCancelOrder, onUpdateOrder,
  onRequestPricePick, injectedEditPrice,
  onRequestTpPick,
  injectedTpPrice,
  instrumentType = 'equity',
  activeRight = null,
  positionCE,
  positionPE,
  runningStrategies = [],
  autostopTriggerType = 'bar',
  autostopDeviationPct = 1.0,
  breakevenMode = 'shift_sl',
  aggrSlOnlyInProfit = false,
  onStartStrategy,
  onCancelAllStrategies,
  onCancelStrategy,
  onUpdateStrategyPrice,
  onBulkUpdateSL,
  onRequestLpPick,
  injectedLpPrice,
  onGuardRailBlocked,
}: Props) {
  const [orderType, setOrderType] = useState<OrderTypeFull>('TARGET')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [ratio, setRatio] = useState<RatioKey>('l')
  const [slQty, setSlQty] = useState(1)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Strategy tab state
  const [stratDirection, setStratDirection] = useState<'BUY' | 'SELL'>('BUY')
  const [stratRight, setStratRight] = useState<'CE' | 'PE'>(activeRight ?? 'CE')
  const [stratRatio, setStratRatio] = useState<RatioKey>('l')
  const [stratQty, setStratQty] = useState(1)
  const [stratLoading, setStratLoading] = useState<string | null>(null)
  const [stratError, setStratError] = useState<string | null>(null)
  const [cancellingAll, setCancellingAll] = useState(false)
  const [tpValue, setTpValue] = useState('')
  const [tpIsPct, setTpIsPct] = useState(false)
  const [utpValue, setUtpValue] = useState('')
  const [lpValue, setLpValue] = useState('')
  const [lpIsPct, setLpIsPct] = useState(false)

  // Batch update SL state
  const [bulkSLPrice, setBulkSLPrice] = useState('')
  const [bulkUpdating, setBulkUpdating] = useState(false)

  // Per-strategy cancel/edit state
  const [cancellingStrategyId, setCancellingStrategyId] = useState<string | null>(null)
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null)
  const [stratEditPrice, setStratEditPrice] = useState('')
  const [stratEditUpdating, setStratEditUpdating] = useState(false)

  // Inline edit state
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [updating, setUpdating] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const isActive = sessionState === 'running' || sessionState === 'paused'
  const hasPosition = position.side !== 'FLAT'
  const parsedPrice = parseFloat(price)
  const deviation = targetDeviationPct  // fraction

  // When SL tab selected, lock side to opposite of position; default qty = uncovered portion
  useEffect(() => {
    if (orderType === 'STOPLOSS') {
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY'
      if (position.side === 'LONG') setSide('SELL')
      else if (position.side === 'SHORT') setSide('BUY')
      const coveredQty = openOrders
        .filter(o => o.is_stoploss && o.side === exitSide && (o.right ?? null) === activeRight && o.status === 'PENDING')
        .reduce((sum, o) => sum + o.quantity, 0)
      setSlQty(Math.max(1, position.quantity - coveredQty))
    }
  }, [orderType, position.side, position.quantity, openOrders, activeRight])

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

  // Inject chart-picked price into TP field
  useEffect(() => {
    if (injectedTpPrice != null) setTpValue(injectedTpPrice.toFixed(2))
  }, [injectedTpPrice])

  // Inject chart-picked price into LP field
  useEffect(() => {
    if (injectedLpPrice != null) setLpValue(injectedLpPrice.toFixed(2))
  }, [injectedLpPrice])

  const autoLimit = orderType === 'TARGET' && !isNaN(parsedPrice)
    ? side === 'BUY'
      ? (parsedPrice * (1 + deviation)).toFixed(2)
      : (parsedPrice * (1 - deviation)).toFixed(2)
    : null

  const ratioPct = fundsRatios[ratio] / 100

  const handlePlace = async () => {
    if (orderType === 'STRAT') return
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
        if (fundsRatioMode) {
          await onPlaceOrder(side, 'LIMIT', mktPrice, null, { funds_ratio_pct: ratioPct })
        } else {
          await onPlaceOrder(side, 'LIMIT', mktPrice, quantity, {})
        }
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
      const msg = e instanceof Error ? e.message : 'Failed to place order'
      if (msg.startsWith('GUARDRAIL:') && onGuardRailBlocked) {
        const reason = msg.slice('GUARDRAIL:'.length).trim()
        const type = reason.startsWith('BAN') ? 'BAN' : reason.startsWith('COOLDOWN') ? 'COOLDOWN' : 'BLOCK'
        onGuardRailBlocked(type, reason)
      } else {
        setError(msg)
      }
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

  // Position for the selected strategy right (options) or equity position
  const stratPosition = instrumentType === 'options'
    ? (stratRight === 'CE' ? positionCE : positionPE) ?? { side: 'FLAT', quantity: 0, avg_entry_price: 0, symbol: '' }
    : position
  const stratHasPosition = stratPosition.side !== 'FLAT'

  const handleStartStrategy = async (
    strategyType: 'AutoStop' | 'BreakEven' | 'AggressiveStoploss' | 'TargetProfit' | 'LockProfit' | 'UnderlyingTargetProfit',
  ) => {
    if (!onStartStrategy) return
    setStratError(null)
    setStratLoading(strategyType)
    try {
      const right = instrumentType === 'options' ? stratRight : null
      const direction = (instrumentType === 'options') ? 'BUY' : stratDirection
      const opts = fundsRatioMode
        ? { fundsRatioPct: fundsRatios[stratRatio] / 100, direction }
        : { quantity: stratQty, direction }
      let extraOpts: Record<string, unknown> = {}
      if (strategyType === 'TargetProfit') {
        const v = parseFloat(tpValue)
        if (isNaN(v) || v <= 0) {
          setStratError('Enter a valid target value')
          setStratLoading(null)
          return
        }
        extraOpts = { targetProfitValue: v, targetProfitIsPct: tpIsPct }
      } else if (strategyType === 'UnderlyingTargetProfit') {
        const v = parseFloat(utpValue)
        if (isNaN(v) || v <= 0) {
          setStratError('Enter a valid underlying target price')
          setStratLoading(null)
          return
        }
        extraOpts = { targetProfitValue: v, targetProfitIsPct: false }
      } else if (strategyType === 'LockProfit') {
        const v = parseFloat(lpValue)
        if (isNaN(v) || v <= 0) {
          setStratError('Enter a valid lock price')
          setStratLoading(null)
          return
        }
        extraOpts = { lockProfitValue: v, lockProfitIsPct: lpIsPct }
      }
      await onStartStrategy(strategyType, right, { ...opts, ...extraOpts })
    } catch (e) {
      setStratError(e instanceof Error ? e.message : 'Failed to start strategy')
    } finally {
      setStratLoading(null)
    }
  }

  const handleCancelStrategy = async (strategyId: string) => {
    if (!onCancelStrategy) return
    setCancellingStrategyId(strategyId)
    try {
      await onCancelStrategy(strategyId)
    } catch (e) {
      setStratError(e instanceof Error ? e.message : 'Failed to cancel strategy')
    } finally {
      setCancellingStrategyId(null)
    }
  }

  const handleSaveStrategyPrice = async (strategyId: string) => {
    if (!onUpdateStrategyPrice) return
    const p = parseFloat(stratEditPrice)
    if (isNaN(p) || p <= 0) return
    setStratEditUpdating(true)
    try {
      await onUpdateStrategyPrice(strategyId, p)
      setEditingStrategyId(null)
      setStratEditPrice('')
    } catch (e) {
      setStratError(e instanceof Error ? e.message : 'Failed to update price')
    } finally {
      setStratEditUpdating(false)
    }
  }

  const handleBulkUpdateSL = async () => {
    if (!onBulkUpdateSL) return
    const p = parseFloat(bulkSLPrice)
    if (isNaN(p) || p <= 0) return
    setBulkUpdating(true)
    try {
      const right = instrumentType === 'options' ? activeRight : null
      await onBulkUpdateSL(p, right ?? null)
      setBulkSLPrice('')
    } catch (e) {
      setStratError(e instanceof Error ? e.message : 'Failed to bulk update SL')
    } finally {
      setBulkUpdating(false)
    }
  }

  const handleCancelAll = async () => {
    if (!onCancelAllStrategies) return
    setCancellingAll(true)
    setStratError(null)
    try {
      await onCancelAllStrategies()
    } catch (e) {
      setStratError(e instanceof Error ? e.message : 'Failed to cancel strategies')
    } finally {
      setCancellingAll(false)
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

      {/* Tgt / Lmt / SL / Mkt / Strat toggle */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
        {btn('Tgt', orderType === 'TARGET', () => { setOrderType('TARGET'); setPrice('') }, !isActive)}
        {btn('Lmt', orderType === 'LIMIT', () => { setOrderType('LIMIT'); setPrice('') }, !isActive)}
        {btn('SL', orderType === 'STOPLOSS',
          () => { if (hasPosition) { setOrderType('STOPLOSS'); setPrice('') } },
          !isActive || !hasPosition,
          orderType === 'STOPLOSS' ? '#8b2300' : undefined,
        )}
        {btn('Mkt', orderType === 'MARKET', () => { setOrderType('MARKET'); setPrice('') }, !isActive)}
        {btn('Strat', orderType === 'STRAT', () => { setOrderType('STRAT'); setStratError(null) }, !isActive, orderType === 'STRAT' ? '#1a3a2f' : undefined)}
      </div>

      {/* ── Strategy panel (Strat tab) ─────────────────────────────────── */}
      {orderType === 'STRAT' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Right selector (options only) */}
          {instrumentType === 'options' && (
            <div>
              <div style={{ fontSize: 10, color: '#8b949e', marginBottom: 3 }}>Options Right</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['CE', 'PE'] as const).map(r => (
                  <button key={r} onClick={() => setStratRight(r)} style={{
                    flex: 1, padding: '4px 0', fontSize: 12, fontWeight: 700,
                    border: `1px solid ${stratRight === r ? '#388bfd' : '#30363d'}`,
                    borderRadius: 4, cursor: 'pointer',
                    background: stratRight === r ? '#1f3a5f' : '#161b22',
                    color: stratRight === r ? '#79c0ff' : '#8b949e',
                  }}>{r}</button>
                ))}
              </div>
            </div>
          )}

          {/* ── Entry Strategies ── */}
          <div style={{ borderTop: '1px solid #21262d', paddingTop: 8 }}>
            <div style={{ fontSize: 10, color: '#3fb950', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
              Entry Strategies
            </div>

            {/* AutoStop */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>AutoStop</div>
              {/* Direction (equity only; options always BUY) */}
              {instrumentType === 'equity' && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  {(['BUY', 'SELL'] as const).map(d => (
                    <button key={d} onClick={() => setStratDirection(d)} style={{
                      flex: 1, padding: '3px 0', fontSize: 11, fontWeight: 600,
                      border: 'none', cursor: 'pointer',
                      background: stratDirection === d ? (d === 'BUY' ? '#1f6feb' : '#da3633') : '#161b22',
                      color: stratDirection === d ? '#fff' : '#8b949e',
                    }}>{d}</button>
                  ))}
                </div>
              )}
              {/* Sizing */}
              {fundsRatioMode ? (
                <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
                  {(['l', 'm', 'h'] as RatioKey[]).map(k => (
                    <button key={k} onClick={() => setStratRatio(k)} style={{
                      flex: 1, padding: '3px 0', fontSize: 11, fontWeight: 700,
                      border: `1px solid ${stratRatio === k ? '#388bfd' : '#30363d'}`,
                      borderRadius: 4, cursor: 'pointer',
                      background: stratRatio === k ? '#1f3a5f' : '#161b22',
                      color: stratRatio === k ? '#79c0ff' : '#8b949e',
                    }}>{k.toUpperCase()}<span style={{ fontSize: 9, display: 'block' }}>{fundsRatios[k]}%</span></button>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
                  {[1, 2, 5, 10].map(q => (
                    <button key={q} onClick={() => setStratQty(q)} style={{
                      flex: 1, padding: '3px 0', fontSize: 11, borderRadius: 4,
                      border: `1px solid ${stratQty === q ? '#388bfd' : '#30363d'}`,
                      background: stratQty === q ? '#1f3a5f' : '#161b22',
                      color: stratQty === q ? '#79c0ff' : '#8b949e',
                      cursor: 'pointer',
                    }}>{q}</button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 9, color: '#484f58', marginBottom: 4 }}>
                {autostopTriggerType === 'bar'
                  ? `Trigger: ${stratDirection === 'BUY' || instrumentType === 'options' ? 'bar high' : 'bar low'}`
                  : `Trigger: close ± ${autostopDeviationPct}%`}
              </div>
              <button
                onClick={() => handleStartStrategy('AutoStop')}
                disabled={stratLoading === 'AutoStop'}
                style={{
                  width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: '1px solid #2ea043', borderRadius: 4, cursor: stratLoading === 'AutoStop' ? 'not-allowed' : 'pointer',
                  background: '#1f4d2e', color: '#56d364',
                }}
              >
                {stratLoading === 'AutoStop' ? 'Starting…' : '▶ Start AutoStop'}
              </button>
            </div>
          </div>

          {/* ── Exit Strategies ── */}
          <div style={{ borderTop: '1px solid #21262d', paddingTop: 8, opacity: stratHasPosition ? 1 : 0.45 }}>
            <div style={{ fontSize: 10, color: '#f0883e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
              Exit Strategies {!stratHasPosition && <span style={{ fontWeight: 400, fontSize: 9 }}>(need position)</span>}
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>
                BreakEven{' '}
                <span title={breakevenMode === 'limit_order'
                  ? 'Places limit order at breakeven + buffer when reached'
                  : 'Shifts SL to breakeven + buffer when price hits threshold'}
                  style={{ cursor: 'help', fontSize: 10 }}>ⓘ</span>
              </div>
              <button
                onClick={() => handleStartStrategy('BreakEven')}
                disabled={!stratHasPosition || stratLoading === 'BreakEven'}
                style={{
                  width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: 'none', borderRadius: 4,
                  cursor: stratHasPosition && stratLoading !== 'BreakEven' ? 'pointer' : 'not-allowed',
                  background: stratHasPosition ? '#3a2a10' : '#161b22',
                  color: stratHasPosition ? '#f0883e' : '#484f58',
                }}
              >
                {stratLoading === 'BreakEven' ? 'Starting…' : '▶ Start BreakEven'}
              </button>
            </div>

            {/* TargetProfit */}
            <div style={{ marginBottom: 2 }}>
              <div style={{ fontSize: 11, color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>
                Target Profit{' '}
                <span title="When option price reaches target, places a LIMIT order to exit. Buffer ticks ensure trigger is past the target."
                  style={{ cursor: 'help', fontSize: 10 }}>ⓘ</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <input
                  type="number"
                  value={tpValue}
                  onChange={e => setTpValue(e.target.value)}
                  placeholder={tpIsPct ? '% of capital' : 'price'}
                  min={0}
                  step={tpIsPct ? 0.1 : 0.05}
                  style={{
                    width: 95, padding: '4px 6px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 4,
                    color: '#e6edf3', fontSize: 12,
                  }}
                />
                {!tpIsPct && onRequestTpPick && (
                  <button
                    onClick={onRequestTpPick}
                    title="Pick price from chart"
                    style={{
                      padding: '4px 7px', background: '#21262d',
                      border: '1px solid #30363d', borderRadius: 4,
                      color: '#8b949e', cursor: 'pointer', fontSize: 11,
                    }}
                  >⊕</button>
                )}
                <label style={{ fontSize: 10, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={tpIsPct}
                    onChange={e => setTpIsPct(e.target.checked)}
                    style={{ accentColor: '#79c0ff' }}
                  />
                  % of Capital
                </label>
              </div>
              <button
                onClick={() => handleStartStrategy('TargetProfit')}
                disabled={!stratHasPosition || stratLoading === 'TargetProfit'}
                style={{
                  width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: 'none', borderRadius: 4,
                  cursor: stratHasPosition && stratLoading !== 'TargetProfit' ? 'pointer' : 'not-allowed',
                  background: stratHasPosition ? '#3a2a10' : '#161b22',
                  color: stratHasPosition ? '#f0883e' : '#484f58',
                }}
              >
                {stratLoading === 'TargetProfit' ? 'Starting…' : '▶ Start TargetProfit'}
              </button>
            </div>

            {/* UnderlyingTargetProfit — options only */}
            {instrumentType === 'options' && (
            <div style={{ marginBottom: 2 }}>
              <div style={{ fontSize: 11, color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>
                Underlying Target{' '}
                <span title="Monitors underlying price. When reached, shifts SL to option LTP ± buffer ticks. Creates SL if none exist."
                  style={{ cursor: 'help', fontSize: 10 }}>ⓘ</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <input
                  type="number"
                  value={utpValue}
                  onChange={e => setUtpValue(e.target.value)}
                  placeholder="underlying price"
                  min={0}
                  step={0.05}
                  style={{
                    width: 95, padding: '4px 6px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 4,
                    color: '#e6edf3', fontSize: 12,
                  }}
                />
                {onRequestTpPick && (
                  <button
                    onClick={onRequestTpPick}
                    title="Pick price from chart"
                    style={{
                      padding: '4px 7px', background: '#21262d',
                      border: '1px solid #30363d', borderRadius: 4,
                      color: '#8b949e', cursor: 'pointer', fontSize: 11,
                    }}
                  >⊕</button>
                )}
              </div>
              <button
                onClick={() => handleStartStrategy('UnderlyingTargetProfit')}
                disabled={!stratHasPosition || stratLoading === 'UnderlyingTargetProfit'}
                style={{
                  width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: 'none', borderRadius: 4,
                  cursor: stratHasPosition && stratLoading !== 'UnderlyingTargetProfit' ? 'pointer' : 'not-allowed',
                  background: stratHasPosition ? '#1a2a3a' : '#161b22',
                  color: stratHasPosition ? '#58a6ff' : '#484f58',
                }}
              >
                {stratLoading === 'UnderlyingTargetProfit' ? 'Starting…' : '▶ Start Underlying Target'}
              </button>
            </div>
            )}

            {/* LockProfit */}
            <div style={{ marginBottom: 2 }}>
              <div style={{ fontSize: 11, color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>
                Lock Profit{' '}
                <span title="When price hits lock level, shifts ALL SL orders to that price (one-time). Creates SL if none exist."
                  style={{ cursor: 'help', fontSize: 10 }}>ⓘ</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <input
                  type="number"
                  value={lpValue}
                  onChange={e => setLpValue(e.target.value)}
                  placeholder={lpIsPct ? '% of capital' : 'price'}
                  min={0}
                  step={lpIsPct ? 0.1 : 0.05}
                  style={{
                    width: 95, padding: '4px 6px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 4,
                    color: '#e6edf3', fontSize: 12,
                  }}
                />
                {!lpIsPct && onRequestLpPick && (
                  <button
                    onClick={onRequestLpPick}
                    title="Pick price from chart"
                    style={{
                      padding: '4px 7px', background: '#21262d',
                      border: '1px solid #30363d', borderRadius: 4,
                      color: '#8b949e', cursor: 'pointer', fontSize: 11,
                    }}
                  >⊕</button>
                )}
                {!lpIsPct && (
                  <button
                    onClick={() => currentPrice > 0 && setLpValue(currentPrice.toFixed(2))}
                    disabled={currentPrice <= 0}
                    title="Use last traded price"
                    style={{
                      padding: '4px 6px', background: '#21262d',
                      border: '1px solid #30363d', borderRadius: 4,
                      color: currentPrice > 0 ? '#8b949e' : '#484f58',
                      cursor: currentPrice > 0 ? 'pointer' : 'not-allowed',
                      fontSize: 10,
                    }}
                  >LTP</button>
                )}
                <label style={{ fontSize: 10, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={lpIsPct}
                    onChange={e => setLpIsPct(e.target.checked)}
                    style={{ accentColor: '#79c0ff' }}
                  />
                  %
                </label>
              </div>
              <button
                onClick={() => handleStartStrategy('LockProfit')}
                disabled={!stratHasPosition || stratLoading === 'LockProfit'}
                style={{
                  width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: 'none', borderRadius: 4,
                  cursor: stratHasPosition && stratLoading !== 'LockProfit' ? 'pointer' : 'not-allowed',
                  background: stratHasPosition ? '#2a1f4a' : '#161b22',
                  color: stratHasPosition ? '#b392f0' : '#484f58',
                }}
              >
                {stratLoading === 'LockProfit' ? 'Starting…' : '▶ Start Lock Profit'}
              </button>
            </div>
          </div>

          {/* ── Trade Management ── */}
          <div style={{ borderTop: '1px solid #21262d', paddingTop: 8, opacity: stratHasPosition ? 1 : 0.45 }}>
            <div style={{ fontSize: 10, color: '#79c0ff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
              Trade Management {!stratHasPosition && <span style={{ fontWeight: 400, fontSize: 9 }}>(need position)</span>}
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>
                Aggressive SL{' '}
                <span title={`One-shot: places a STOPLOSS at 1% from bar close to lock in profit.${aggrSlOnlyInProfit ? ' Only triggers when bar closes in profit.' : ''}`}
                  style={{ cursor: 'help', fontSize: 10 }}>ⓘ</span>
              </div>
              <button
                onClick={() => handleStartStrategy('AggressiveStoploss')}
                disabled={!stratHasPosition || stratLoading === 'AggressiveStoploss'}
                style={{
                  width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: 'none', borderRadius: 4,
                  cursor: stratHasPosition && stratLoading !== 'AggressiveStoploss' ? 'pointer' : 'not-allowed',
                  background: stratHasPosition ? '#1a2a4a' : '#161b22',
                  color: stratHasPosition ? '#79c0ff' : '#484f58',
                }}
              >
                {stratLoading === 'AggressiveStoploss' ? 'Starting…' : '▶ Start Aggressive SL'}
              </button>
            </div>
          </div>

          {/* ── Running Strategies ── */}
          {runningStrategies.length > 0 && (
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 8 }}>
              <div style={{ fontSize: 10, color: '#8b949e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 5 }}>
                Running ({runningStrategies.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                {runningStrategies.map(s => {
                  const isEditing = editingStrategyId === s.strategy_id
                  const canEditPrice = s.strategy_type === 'LockProfit' || s.strategy_type === 'TargetProfit' || s.strategy_type === 'UnderlyingTargetProfit'
                  return (
                    <div key={s.strategy_id} style={{ background: '#0d1117', borderRadius: 5, border: '1px solid #21262d', overflow: 'hidden' }}>
                      <div style={{ fontSize: 10, color: '#3fb950', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px' }}>
                        <span>•</span>
                        <span style={{ flex: 1 }}>{s.strategy_type}</span>
                        {s.right && <span style={{ color: '#58a6ff' }}>{s.right}</span>}
                        {s.triggered && (
                          <span style={{ color: '#8b949e', fontSize: 9, background: '#21262d', padding: '1px 4px', borderRadius: 3 }}>triggered</span>
                        )}
                        {canEditPrice && onUpdateStrategyPrice && !isEditing && (
                          <button
                            onClick={() => { setEditingStrategyId(s.strategy_id); setStratEditPrice('') }}
                            title="Update price"
                            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}
                          >✎</button>
                        )}
                        {onCancelStrategy && (
                          <button
                            onClick={() => handleCancelStrategy(s.strategy_id)}
                            disabled={cancellingStrategyId === s.strategy_id}
                            title="Cancel this strategy"
                            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}
                          >✕</button>
                        )}
                      </div>
                      {isEditing && (
                        <div style={{ padding: '5px 6px', borderTop: '1px solid #21262d', display: 'flex', gap: 4 }}>
                          <input
                            type="number"
                            value={stratEditPrice}
                            onChange={e => setStratEditPrice(e.target.value)}
                            placeholder="new price"
                            autoFocus
                            step={0.05}
                            style={{
                              width: 95, padding: '3px 5px', background: '#161b22',
                              border: '1px solid #388bfd', borderRadius: 4,
                              color: '#e6edf3', fontSize: 11,
                            }}
                          />
                          <button
                            onClick={() => currentPrice > 0 && setStratEditPrice(currentPrice.toFixed(2))}
                            disabled={currentPrice <= 0}
                            style={{ padding: '3px 5px', background: '#21262d', border: '1px solid #30363d', borderRadius: 4, color: '#8b949e', cursor: 'pointer', fontSize: 10 }}
                          >LTP</button>
                          <button
                            onClick={() => handleSaveStrategyPrice(s.strategy_id)}
                            disabled={stratEditUpdating}
                            style={{ padding: '3px 6px', background: '#1f6feb', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}
                          >{stratEditUpdating ? '…' : 'Set'}</button>
                          <button
                            onClick={() => setEditingStrategyId(null)}
                            style={{ padding: '3px 5px', background: '#21262d', border: '1px solid #30363d', borderRadius: 4, color: '#8b949e', cursor: 'pointer', fontSize: 10 }}
                          >✕</button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <button
                onClick={handleCancelAll}
                disabled={cancellingAll}
                style={{
                  width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: '1px solid #6e2a2a', borderRadius: 4,
                  cursor: cancellingAll ? 'not-allowed' : 'pointer',
                  background: '#21262d', color: '#f85149',
                }}
              >
                {cancellingAll ? 'Cancelling…' : '✕ Cancel All Strategies'}
              </button>
            </div>
          )}

          {stratError && <div style={{ fontSize: 10, color: '#f85149' }}>{stratError}</div>}
        </div>
      )}

      {/* ── Order form (hidden when Strat tab is active) ─────────────── */}
      {orderType !== 'STRAT' && (
      <>
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
              flex: 1, minWidth: 0, padding: '5px 8px', background: '#0d1117',
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
          <button
            onClick={() => currentPrice > 0 && setPrice(currentPrice.toFixed(2))}
            disabled={!isActive || currentPrice <= 0}
            title="Use last traded price"
            style={{
              padding: '4px 7px', background: '#21262d',
              border: '1px solid #30363d', borderRadius: 6,
              color: isActive && currentPrice > 0 ? '#8b949e' : '#484f58',
              cursor: isActive && currentPrice > 0 ? 'pointer' : 'not-allowed',
              fontSize: 10, whiteSpace: 'nowrap',
            }}
          >LTP</button>
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
          {/* Split hint for large index options SL orders */}
          {instrumentType === 'options' && (() => {
            const sym = position.symbol?.toUpperCase() ?? ''
            const maxPerOrder = sym.startsWith('NIFTY') ? 1800 : sym.startsWith('SENSEX') ? 1000 : sym.startsWith('BANKNIFTY') ? 900 : null
            if (!maxPerOrder || slQty <= maxPerOrder) return null
            const n = Math.ceil(slQty / maxPerOrder)
            return (
              <div style={{ fontSize: 9, color: '#8b949e', marginTop: 3 }}>
                Will create {n} orders (max {maxPerOrder}/order)
              </div>
            )
          })()}
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
      </>
      )}

      {/* Open orders */}
      {openOrders.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Open Orders ({openOrders.length})
          </div>

          {/* Batch Update SL — shown when 2+ SL orders exist for active tab */}
          {(() => {
            const slOrders = openOrders.filter(o =>
              o.is_stoploss &&
              o.status === 'PENDING' &&
              (o.right ?? null) === (activeRight ?? null)
            )
            if (slOrders.length < 2 || !onBulkUpdateSL) return null
            const rightLabel = activeRight ? ` ${activeRight}` : ''
            return (
              <div style={{ marginBottom: 6, padding: '6px 8px', background: '#0d1117', borderRadius: 5, border: '1px solid #4a2000' }}>
                <div style={{ fontSize: 9, color: '#f0883e', marginBottom: 4, fontWeight: 600 }}>
                  Update All{rightLabel} SLs ({slOrders.length} orders)
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="number"
                    value={bulkSLPrice}
                    onChange={e => setBulkSLPrice(e.target.value)}
                    placeholder="price"
                    step={0.05}
                    style={{
                      width: 95, padding: '3px 6px', background: '#161b22',
                      border: '1px solid #4a2000', borderRadius: 4,
                      color: '#e6edf3', fontSize: 11,
                    }}
                  />
                  <button
                    onClick={() => currentPrice > 0 && setBulkSLPrice(currentPrice.toFixed(2))}
                    disabled={currentPrice <= 0}
                    title="Use last traded price"
                    style={{ padding: '3px 6px', background: '#21262d', border: '1px solid #30363d', borderRadius: 4, color: currentPrice > 0 ? '#8b949e' : '#484f58', cursor: currentPrice > 0 ? 'pointer' : 'not-allowed', fontSize: 10 }}
                  >LTP</button>
                  <button
                    onClick={handleBulkUpdateSL}
                    disabled={bulkUpdating || !bulkSLPrice}
                    style={{
                      padding: '3px 8px', background: bulkSLPrice ? '#3a2000' : '#161b22',
                      border: '1px solid #4a2000', borderRadius: 4,
                      color: bulkSLPrice ? '#f0883e' : '#484f58',
                      cursor: bulkSLPrice && !bulkUpdating ? 'pointer' : 'not-allowed',
                      fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                    }}
                  >{bulkUpdating ? '…' : 'Update All'}</button>
                </div>
              </div>
            )
          })()}

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
                            width: 95, padding: '4px 6px', background: '#0d1117',
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
                        <button
                          onClick={() => currentPrice > 0 && setEditPrice(currentPrice.toFixed(2))}
                          disabled={currentPrice <= 0}
                          title="Use last traded price"
                          style={{
                            padding: '4px 7px', background: '#21262d',
                            border: '1px solid #30363d', borderRadius: 4,
                            color: currentPrice > 0 ? '#8b949e' : '#484f58',
                            cursor: currentPrice > 0 ? 'pointer' : 'not-allowed',
                            fontSize: 10, whiteSpace: 'nowrap',
                          }}
                        >LTP</button>
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
