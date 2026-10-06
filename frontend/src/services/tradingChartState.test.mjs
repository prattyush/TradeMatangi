import assert from 'node:assert/strict'
import test from 'node:test'
import { openPositionTrades, RecentLiveTicks, reconcileChartObjects, IndicatorHistoryRequests } from './tradingChartState.ts'
import { rememberChartData, clearChartDataCache } from './chartDataCache.ts'

const fill = (id, side, quantity = 10, overrides = {}) => ({
  trade_id: String(id), timestamp: id, session_id: 's', symbol: 'BSESEN',
  side, quantity, price: 100, commission: 0, right: 'CE', strike: 80000,
  expiry: '2026-10-08', ...overrides,
})
const ids = trades => openPositionTrades(trades).map(trade => trade.trade_id)

test('partial exits and additions stay visible until the contract is flat', () => {
  const trades = [fill(1, 'BUY'), fill(2, 'BUY'), fill(3, 'SELL', 5)]
  assert.deepEqual(ids(trades), ['1', '2', '3'])
  trades.push(fill(4, 'SELL', 15))
  assert.deepEqual(ids(trades), [])
  trades.push(fill(5, 'BUY'))
  assert.deepEqual(ids(trades), ['5'])
})

test('rights, strikes, expiries and sessions have independent cycles', () => {
  const trades = [fill(1, 'BUY'), fill(2, 'BUY', 10, { right: 'PE' }),
    fill(3, 'BUY', 10, { strike: 80100 }), fill(4, 'BUY', 10, { expiry: '2026-10-15' }),
    fill(5, 'BUY', 10, { session_id: 'other' }), fill(6, 'SELL')]
  assert.deepEqual(ids(trades), ['2', '3', '4', '5'])
})

test('short positions and reversals discard the closed cycle', () => {
  assert.deepEqual(ids([fill(1, 'BUY'), fill(2, 'SELL', 20)]), ['2'])
  assert.deepEqual(ids([fill(1, 'SELL'), fill(2, 'BUY', 5)]), ['1', '2'])
  assert.deepEqual(ids([fill(1, 'SELL'), fill(2, 'BUY')]), [])
})

test('legacy fills infer expiry only when the same contract has one known expiry', () => {
  assert.deepEqual(ids([fill(1, 'BUY', 10, { expiry: undefined }), fill(2, 'SELL')]), [])
  assert.deepEqual(ids([fill(1, 'BUY', 10, { expiry: undefined }), fill(2, 'SELL'),
    fill(3, 'BUY', 10, { expiry: '2026-10-15' })]), ['1', '2', '3'])
})

test('corrected cumulative fills and out-of-order history are recomputed without mutation', () => {
  const trades = [fill(2, 'SELL', 5), fill(1, 'BUY')]
  assert.deepEqual(ids(trades), ['2', '1'])
  const corrected = [fill(2, 'SELL'), trades[1]]
  assert.deepEqual(ids(corrected), [])
  assert.equal(trades[0].quantity, 5)
})

test('price-only updates retain objects; closing and restoring all markers reconcile incrementally', () => {
  const objects = new Map()
  let creates = 0, updates = 0, removes = 0
  const reconcile = trades => reconcileChartObjects(objects, trades.map(t => ({ id: t.trade_id, signature: String(t.price), input: t })),
    input => { creates++; return { price: input.price } },
    (object, input) => { updates++; object.price = input.price }, () => { removes++ })
  const trades = [fill(1, 'BUY')]
  reconcile(openPositionTrades(trades))
  const original = objects.get('1').object
  for (let i = 0; i < 3600; i++) reconcile(openPositionTrades(trades))
  assert.equal(creates, 1)
  assert.equal(objects.get('1').object, original)
  reconcile([{ ...trades[0], price: 101 }])
  assert.equal(updates, 1)
  trades.push(fill(2, 'SELL'))
  reconcile(openPositionTrades(trades))
  assert.equal(objects.size, 0)
  assert.equal(removes, 1)
  reconcile(trades) // All markers on
  assert.equal(objects.size, 2)
  reconcile(openPositionTrades(trades)) // All markers off
  assert.equal(objects.size, 0)
})

test('recent ticks retain only fifteen minutes and reject out-of-order data', () => {
  const cache = new RecentLiveTicks()
  for (let time = 0; time <= 3600; time++) cache.append({ time, close: time })
  assert.equal(cache.values().length, 901)
  assert.equal(cache.values()[0].time, 2700)
  assert.equal(cache.append({ time: 3000, close: -1 }), false)
  cache.append({ time: 3600, close: 42 })
  assert.equal(cache.values().at(-1).close, 42)
  cache.clear()
  assert.deepEqual(cache.values(), [])
})

test('history requests coalesce even during forced refresh and return isolated data', async () => {
  clearChartDataCache()
  let resolve, calls = 0
  const loader = () => { calls++; return new Promise(done => { resolve = done }) }
  const first = rememberChartData('same', loader)
  const second = rememberChartData('same', loader, true)
  resolve([{ time: 1, close: 100 }])
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1)
  a[0].close = 0
  assert.equal(b[0].close, 100)
  clearChartDataCache()
})


test('auxiliary history loads require demand, coalesce, and cool down after completion', () => {
  const gate = new IndicatorHistoryRequests()
  gate.configure('session-a', new Set())
  assert.equal(gate.begin('CE', 0), null)
  gate.configure('session-a', new Set(['CE']))
  const request = gate.begin('CE', 0)
  assert.equal(request.current(), true)
  assert.equal(gate.begin('CE', 1000), null)
  request.finish(1000)
  assert.equal(gate.begin('CE', 5999), null)
  assert.ok(gate.begin('CE', 6000))
})

test('late history responses cannot publish after a session or selection change', () => {
  const gate = new IndicatorHistoryRequests()
  gate.configure('session-a', new Set(['CE']))
  const old = gate.begin('CE', 0)
  gate.configure('session-b', new Set(['CE']))
  const next = gate.begin('CE', 0)
  assert.equal(old.current(), false)
  old.finish(0)
  assert.equal(next.current(), true)
  gate.configure('session-b', new Set())
  assert.equal(next.current(), false)
  gate.configure('session-b', new Set(['CE']))
  assert.ok(gate.begin('CE', 0))
})
