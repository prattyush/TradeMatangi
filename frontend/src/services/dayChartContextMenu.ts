import type { Dispatch, SetStateAction } from 'react';
import type { useSimulation } from '../hooks/useSimulation';
import type { EntryTicket } from '../components/ChartEntryTicket';
import type { ContextMenuAction } from '../components/ChartContextMenu';
import type { SizingMode } from '../components/SettingsModal';
import api, { ApiError, type BrokerSnapshot, type StrategyResponse } from './api';
import { pendingOrderEdits } from '../../../shared/charts/pendingOrderEdits';
import { matchesChartContract, runChartOrderBatch, underlyingOptionsChart } from './chartOrderContext';
export interface DayChartMenuContext { sessionId: string; paneId: number; price: number; x: number; y: number; paneType: string; right?: 'CE' | 'PE'; strike?:number; expiry?:string }
export interface DayChartMenuPane { id:number;type:string;right?:'CE'|'PE';strike?:number;expiry?:string }
interface MenuEnvironment {
  contextMenu: DayChartMenuContext | null;
  sim: ReturnType<typeof useSimulation>;
  simRef: {current: {sessionId: string | null}};
  panes: DayChartMenuPane[];
  sizingMode: SizingMode;
  cancelPricePick: () => void;
  setMissingSlPick: (pick: {sessionId:string;paneId:number;right?:string;strike?:number;expiry?:string;quantity:number;requestId:string}) => void;
  setContextMenuEntryTicket: (ticket: EntryTicket) => void;
  setBrokerError: (message:string|null) => void;
  strategySyncVersionRef: {current:number};
  setRunningStrategies: Dispatch<SetStateAction<StrategyResponse[]>>;
  setBrokerOrdersSnapshot: (value:{sessionId:string;orders:BrokerSnapshot['orders']}) => void;
  targetDeviationPct: number;
}
/** Shared production menu policy for both website renderers. Broker writes remain existing API calls. */
export function buildDayChartContextMenu({contextMenu,sim,simRef,panes,sizingMode,cancelPricePick,setMissingSlPick,setContextMenuEntryTicket,setBrokerError,strategySyncVersionRef,setRunningStrategies,setBrokerOrdersSnapshot,targetDeviationPct}:MenuEnvironment):ContextMenuAction[] {
    if (!contextMenu || !sim.sessionId || contextMenu.sessionId !== sim.sessionId) return []

    const { price } = contextMenu
    const actions: ContextMenuAction[] = []

    const pane = panes.find(p => p.id === contextMenu.paneId)
    if (!pane || pane.type !== contextMenu.paneType || !matchesChartContract(contextMenu,pane)) return []
    const right = pane.type === 'options' ? pane.right : undefined
    const underlying = underlyingOptionsChart(pane, sim.sessionInstrumentType)
    const scopedOrders = sim.openOrders.filter(o => o.status === 'PENDING' && matchesChartContract(o, pane))
    const refreshChartOrders = async () => {
      const sessionId = sim.sessionId!
      if (sim.sessionType !== 'real' || simRef.current.sessionId !== sessionId) return
      const snapshot = await api.reconcileKotakOrders(sessionId)
      if(simRef.current.sessionId === sessionId) { sim.applyBrokerSnapshot(sessionId,snapshot);setBrokerOrdersSnapshot({sessionId,orders:snapshot.orders});setBrokerError(snapshot.wallet_error??null) }
    }
    const startChartStrategy = async (request: Parameters<typeof api.startStrategy>[0]) => {
      if(simRef.current.sessionId !== request.session_id) throw new Error('Session changed')
      return api.startStrategy(request)
    }

    const netQuantity = right ? sim.trades.filter(t => t.session_id === sim.sessionId && t.right === right && t.strike === pane?.strike && (t.expiry ?? sim.sessionExpiry) === pane?.expiry).reduce((sum, t) => sum + (t.side === 'BUY' ? t.quantity : -t.quantity), 0) : 0
    const position = right ? { side: netQuantity > 0 ? 'LONG' : netQuantity < 0 ? 'SHORT' : 'FLAT', quantity: Math.abs(netQuantity) } : sim.position
    const closingSide = position.side === 'LONG' ? 'SELL' : position.side === 'SHORT' ? 'BUY' : null
    const closingSLOrders = scopedOrders.filter(o => o.is_stoploss && o.side === closingSide)
    if (!(underlying) && position?.side !== 'FLAT' && position?.quantity > 0) {
      const covered = sim.openOrders.filter(o => o.status === 'PENDING' && o.side === (position.side === 'LONG' ? 'SELL' : 'BUY') && (o.right ?? null) === (right ?? null) && (!right || (o.strike === pane?.strike && o.expiry === pane?.expiry))).reduce((sum, o) => sum + o.quantity, 0)
      const quantity = Math.max(0, position.quantity - covered)
      actions.push({ label: `SL · ${quantity}`, disabled: quantity === 0, onClick: () => {
        cancelPricePick()
        setMissingSlPick({ sessionId: sim.sessionId!, paneId: contextMenu.paneId, right, strike: right ? pane?.strike : undefined, expiry: right ? pane?.expiry : undefined, quantity, requestId: crypto.randomUUID() })
      } })
    }

    // "Use as SL" actions
    const slMode = localStorage.getItem('contextMenuSLMode') === 'both' ? 'both' : 'longOnly'

    if (underlying) actions.push({ label: 'Place option orders on a CE/PE chart', disabled: true })
    if (!underlying) actions.push({
      label: `Use as SL @ ${price.toFixed(2)}`,
      onClick: () => setContextMenuEntryTicket({ sessionId:sim.sessionId!, paneId:pane.id, symbol:sim.symbol, x: contextMenu.x, y: contextMenu.y, price, right,
        strike: pane?.strike, expiry: pane?.expiry, side: slMode === 'both' ? null : 'BUY', sizingMode }),
    })

    // Shift SL to here
    const hasSLOrders = !underlying && closingSLOrders.length > 0
    if (hasSLOrders) {
      actions.push({
        label: 'Shift SL to here',
        onClick: () => {
          void runChartOrderBatch(closingSLOrders, async order => {
            if (simRef.current.sessionId !== sim.sessionId) throw new Error('Session changed')
            if (pendingOrderEdits.get(sim.sessionId!,order.order_id)) throw new Error('Refresh Trade History before modifying an unconfirmed order')
            const brokerOwned = sim.sessionType === 'real' && Boolean(order.broker_order_id ?? order.kotak_order_id)
            if (brokerOwned) pendingOrderEdits.begin(order,price)
            try {
              const updated = await sim.updateOrder(order.order_id, order.order_type === 'LIMIT' ? undefined : price, order.order_type === 'LIMIT' ? price : undefined, targetDeviationPct)
              if (brokerOwned) pendingOrderEdits.acknowledged(sim.sessionId!,order.order_id,updated)
            } catch(error) {
              if(brokerOwned)pendingOrderEdits.failed(sim.sessionId!,order.order_id,error instanceof ApiError && error.status>=400 && error.status<500 && ![408,409,429].includes(error.status))
              throw error
            }
          }).then(refreshChartOrders).catch(error => setBrokerError(String(error)))
        }
      })
    }

    // Make as limit price
    const hasOpenOrders = !underlying && scopedOrders.some(o => !o.is_stoploss)
    if (hasOpenOrders) {
      actions.push({
        label: 'Make as limit price',
        onClick: () => {
          void runChartOrderBatch(scopedOrders.filter(o => !o.is_stoploss), async order => {
            const sessionId = sim.sessionId!
            if (simRef.current.sessionId !== sessionId) throw new Error('Session changed')
            if (pendingOrderEdits.get(sessionId,order.order_id)) throw new Error('Refresh Trade History before modifying an unconfirmed order')
            const updated = await api.convertOrder(sessionId, order.order_id, 'LIMIT', price)
            if (simRef.current.sessionId === sessionId) sim.bulkUpdateOrders([updated])
            if (updated.broker_conversion && updated.broker_conversion.state !== 'confirmed') throw new Error(updated.broker_conversion.message ?? 'Conversion is not confirmed; refresh Trade History')
          }).catch(error => setBrokerError(String(error)))
        }
      })
    }

    // Start strategy
    const stratActions: ContextMenuAction[] = underlying || position.side === 'FLAT' ? [] : [
      {
        label: 'Target Profit',
        submenu: (['half', 'full'] as const).map(size => ({
          label: size === 'half' ? 'Half' : 'Full',
          onClick: () => { startChartStrategy({ session_id: sim.sessionId!, strategy_type: 'TargetProfit', target_profit_value: price, target_profit_size: size, right: right ?? undefined, strike:pane.strike, expiry:pane.expiry }).then(resp => { if(simRef.current.sessionId !== sim.sessionId)return; strategySyncVersionRef.current++; setRunningStrategies(prev => [...prev, resp]) }).catch(error => setBrokerError(String(error))) },
        })),
      },
      {
        label: 'Lock Profit',
        onClick: () => {
          startChartStrategy({
            session_id: sim.sessionId!,
            strategy_type: 'LockProfit',
            lock_profit_value: price,
            right: right ?? undefined, strike:pane.strike, expiry:pane.expiry,
          }).then(resp => { if(simRef.current.sessionId !== sim.sessionId)return; strategySyncVersionRef.current++; setRunningStrategies(prev => [...prev, resp]) }).catch(error => setBrokerError(String(error)))
        }
      },
    ]

    // Aggressive SL — requires open position on current pane (not for underlying pane in options)
    if (!(underlying)) {
      const panePosition = position
      if (panePosition && panePosition.side !== 'FLAT') {
        stratActions.push({
          label: 'Aggressive SL',
          onClick: () => {
            startChartStrategy({
              session_id: sim.sessionId!,
              strategy_type: 'AggressiveStoploss',
              right: right ?? undefined, strike:pane.strike, expiry:pane.expiry,
            }).then(resp => { if(simRef.current.sessionId !== sim.sessionId)return; strategySyncVersionRef.current++; setRunningStrategies(prev => [...prev, resp]) }).catch(error => setBrokerError(String(error)))
          }
        })
      }
    }

    // Underlying-only strategies (equity pane in options sessions)
    if (underlying) {
      for (const targetRight of (['CE', 'PE'] as const)) {
        if ((targetRight === 'CE' ? sim.positionCE : sim.positionPE).side === 'FLAT') continue
        stratActions.push({
          label: `Underlying Target (${targetRight})`,
          submenu: (['half', 'full'] as const).map(size => ({ label: size === 'half' ? 'Half' : 'Full', onClick: () => { startChartStrategy({ session_id: sim.sessionId!, strategy_type: 'UnderlyingTargetProfit', target_profit_value: price, target_profit_size: size, right: targetRight, strike:targetRight==='CE'?sim.sessionStrikeCE??undefined:sim.sessionStrikePE??undefined,expiry:sim.sessionExpiry??undefined }).then(resp => { if(simRef.current.sessionId !== sim.sessionId)return; strategySyncVersionRef.current++; setRunningStrategies(prev => [...prev, resp]) }).catch(error => setBrokerError(String(error))) } })),
        })
      }
      for (const targetRight of (['CE', 'PE'] as const)) {
        if ((targetRight === 'CE' ? sim.positionCE : sim.positionPE).side === 'FLAT') continue
        stratActions.push({ label: `Underlying SL (${targetRight})`, submenu: (['half', 'full'] as const).map(size => ({
          label: size === 'half' ? 'Half' : 'Full', onClick: () => {
            startChartStrategy({ session_id: sim.sessionId!, strategy_type: 'UnderlyingStoploss', underlying_sl_price: price,
              underlying_stoploss_size: size, right: targetRight, strike:targetRight==='CE'?sim.sessionStrikeCE??undefined:sim.sessionStrikePE??undefined,expiry:sim.sessionExpiry??undefined }).then(resp => { if(simRef.current.sessionId !== sim.sessionId)return; strategySyncVersionRef.current++; setRunningStrategies(prev => [...prev, resp]) }).catch(error => setBrokerError(String(error)))
          }
        })) })
      }
    }

    if (stratActions.length) actions.push({ label: 'Start strategy', submenu: stratActions })

    return actions
}
