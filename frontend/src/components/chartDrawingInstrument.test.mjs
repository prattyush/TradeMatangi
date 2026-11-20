import assert from 'node:assert/strict'
import test from 'node:test'
import { chartDrawingInstrument } from './chartDrawingInstrument.ts'
import { drawingIdentity, canonicalDrawingKey } from '../../../shared/charts/drawingIdentity.ts'
import { isLegacyKeyOf } from './analysis/lightweightPersist.ts'

// The KLine chart built these objects inline before they moved here; the keys must not change or saved drawings are orphaned.
test('an option pane is the option identity, with the feed venue only on a swing chart', () => {
  const day = chartDrawingInstrument({ paneType: 'options', symbol: 'NIFTY', right: 'CE', strike: 24500, expiry: '2026-11-26' })
  assert.deepEqual(day, { kind: 'option', underlying: 'NIFTY', exchange: 'NSE', right: 'CE', strike: 24500, expiry: '2026-11-26' })
  assert.equal(chartDrawingInstrument({ paneType: 'options', symbol: 'NIFTY', swingChart: true, right: 'PE', strike: 1, expiry: 'x' }).exchange, 'NFO')
  assert.equal(chartDrawingInstrument({ paneType: 'options', symbol: 'BSESEN', right: 'PE', strike: 1, expiry: 'x' }).exchange, 'BSE')
  assert.equal(chartDrawingInstrument({ paneType: 'options', symbol: 'BSESEN', swingChart: true, right: 'PE', strike: 1, expiry: 'x' }).exchange, 'BFO')
})

test('futures and underlying panes', () => {
  assert.deepEqual(chartDrawingInstrument({ paneType: 'futures', symbol: 'NIFTY', expiry: '2026-11-26' }), { kind: 'future', underlying: 'NIFTY', exchange: 'NFO', expiry: '2026-11-26' })
  assert.deepEqual(chartDrawingInstrument({ paneType: 'equity', symbol: 'RELIANCE' }), { kind: 'equity', symbol: 'RELIANCE', exchange: 'NSE' })
  assert.deepEqual(chartDrawingInstrument({ paneType: 'equity', symbol: 'NIFTY', catalogueKind: 'index' }), { kind: 'index', symbol: 'NIFTY', exchange: 'NSE' })
  // the screen's own kind wins over the catalogue's
  assert.equal(chartDrawingInstrument({ symbol: 'NIFTY', chartKind: 'index', catalogueKind: 'equity' }).kind, 'index')
})

test('a swing chart shares the day drawings of its contract and still reads its old private scope', () => {
  const swing = chartDrawingInstrument({ paneType: 'options', symbol: 'NIFTY', swingChart: true, right: 'CE', strike: 24500, expiry: '2026-11-26' })
  const identity = drawingIdentity(swing, undefined, 'swing:abc:primary', true)
  const day = drawingIdentity(chartDrawingInstrument({ paneType: 'options', symbol: 'NIFTY', right: 'CE', strike: 24500, expiry: '2026-11-26' }), undefined, undefined, true)
  assert.equal(canonicalDrawingKey(identity.writeInstrument), canonicalDrawingKey(day.writeInstrument)) // NFO -> NSE, shared with Day
  assert.ok(identity.readKeys.some(key => key.includes('"drawing_scope":"swing:abc:primary"'))) // old scoped records are still read
  assert.ok(identity.readKeys.some(key => key.includes('"exchange":"NFO"'))) // and the older feed-venue ones
})

test('browser-only drawings saved per candle interval are all found under one base', () => {
  const base = 'browse-drawings:NIFTY:CE:24500:2026-11-26'
  assert.ok(isLegacyKeyOf(base, base))
  assert.ok(isLegacyKeyOf(base, `${base}:3`))
  assert.ok(isLegacyKeyOf(base, `${base}:15`))
  assert.ok(isLegacyKeyOf(base, `${base}:3m`))
  assert.ok(isLegacyKeyOf(base, `${base}:1h`))
  assert.ok(isLegacyKeyOf(base, `${base}:1D`))
  assert.ok(isLegacyKeyOf(base, `${base}:deepdive:2026-11-18`))
  assert.ok(!isLegacyKeyOf(base, `${base}:abc`))
  assert.ok(!isLegacyKeyOf(base, 'browse-drawings:NIFTY:PE:24500:2026-11-26:3'))
  assert.ok(!isLegacyKeyOf('', 'browse-drawings:NIFTY:CE:24500:2026-11-26:3'))
})
