import assert from 'node:assert/strict'
import test from 'node:test'
import { contractPosition, unrealizedPnl, advancePositionClock, mergeConfirmedTrade } from './positionAccounting.ts'
const position = { symbol:'NIFTY', side:'LONG', quantity:65, avg_entry_price:60, entry_commission:1.2653, right:'CE', strike:25000, expiry:'2026-10-08' }

test('repaired position retains entry fees and selects exact contract', () => {
  const result = contractPosition('NIFTY', [position, { ...position, strike:25100, avg_entry_price:90 }], 'CE', 25000, '2026-10-08')
  assert.equal(result.avg_entry_price, 60)
  assert.equal(result.entry_commission, 1.2653)
  assert.equal(contractPosition('NIFTY', [position], 'PE', 25000, '2026-10-08').quantity, 0)
})

test('chart and panel share the same net P&L and capital percentage', () => {
  const pnl = unrealizedPnl(position, 65, 1)
  assert.ok(Math.abs(pnl - (325 - 1.2653 - (4225 * .001333 + 1))) < 1e-9)
  assert.equal(((pnl / 100000) * 100).toFixed(2), '0.32')
  assert.equal(unrealizedPnl(position, null, 1), null)
  assert.equal(unrealizedPnl({ ...position, side:'FLAT', quantity:0 }, null, 1), 0)
})

test('older responses and retired backend generations cannot overwrite repaired state', () => {
  let clock = {version:10, generation:'a', retired:[]}
  assert.equal(advancePositionClock(clock, {state_version:9,state_generation:'a'}), null)
  clock = advancePositionClock(clock, {state_version:1,state_generation:'b'})
  assert.equal(advancePositionClock(clock, {state_version:20,state_generation:'a'}), null)
  assert.equal(advancePositionClock(clock, {calculation_verified:false}), null)
})

test('duplicate broker fill IDs after snapshot do not double-count history', () => {
  const trade = { trade_id:'snapshot-id', kotak_order_id:'K', quantity:130 }
  const trades = [trade]
  assert.equal(mergeConfirmedTrade(trades, {trade_id:'live-id',kotak_order_id:'K',quantity:65}), trades)
  assert.equal(mergeConfirmedTrade(trades, {trade_id:'live-id',kotak_order_id:'K',quantity:195}).length, 1)
})
