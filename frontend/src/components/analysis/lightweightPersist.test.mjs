import assert from 'node:assert/strict'
import test from 'node:test'
import { fromPersisted, legacyToSpecs, specSignature, toPersisted } from './lightweightPersist.ts'

const a = { time: 1_790_000_000, price: 24400 }
const b = { time: 1_790_000_600, price: 24460.5 }

test('every Lightweight drawing is saved as the KLine tool of the same name and comes back unchanged', () => {
  const specs = [
    { kind: 'hline', pts: [a] },
    { kind: 'trendline', pts: [a, b] },
    { kind: 'fibretracement', pts: [b, a] },
    { kind: 'rect', pts: [a, b] },
    { kind: 'text', pts: [a], text: 'Support', color: '#facc15' },
    { kind: 'buymarker', pts: [a], text: 'Buy UL' },
    { kind: 'sellmarker', pts: [b], text: 'Sell UL' },
    { kind: 'rrindicator', pts: [a, b] },
  ]
  const tools = specs.map(spec => toPersisted(spec).tool)
  assert.deepEqual(tools, ['Horizontal', 'Trend', 'Fib Retracement', 'rect', 'Text', 'Buy Marker', 'Sell Marker', 'Risk Reward'])
  for (const spec of specs) {
    const record = toPersisted(spec)
    const back = fromPersisted(JSON.parse(JSON.stringify(record)))
    assert.deepEqual(back, { spec, locked: false }, spec.kind)
  }
})

test('the saved record has the integer timestamps and numeric prices the backend requires, and the clicks in order', () => {
  const record = toPersisted({ kind: 'rrindicator', pts: [{ time: 100.4, price: 24400 }, { time: 200.6, price: 24420 }] })
  assert.deepEqual(record.points, [{ timestamp: 100, price: 24400 }, { timestamp: 201, price: 24420 }]) // stop first, then entry
  assert.equal(record.visible, true)
  assert.equal(record.locked, false)
})

test('a text is kept to 80 characters and a marker keeps its default text', () => {
  assert.equal(toPersisted({ kind: 'text', pts: [a], text: 'x'.repeat(200) }).text.length, 80)
  assert.equal(toPersisted({ kind: 'buymarker', pts: [a] }).text, 'Buy UL')
  assert.equal(fromPersisted({ tool: 'Sell Marker', points: [{ timestamp: 5, price: 1 }] }).spec.text, 'Sell UL')
})

test('records this chart does not draw are skipped, never turned into something else', () => {
  assert.equal(fromPersisted({ tool: 'ray', points: [{ timestamp: 1, price: 1 }, { timestamp: 2, price: 2 }] }), null)
  assert.equal(fromPersisted({ tool: 'longPosition', points: [{ timestamp: 1, price: 1 }, { timestamp: 2, price: 2 }, { timestamp: 3, price: 3 }] }), null)
  assert.equal(fromPersisted({ tool: 'Trend', points: [{ timestamp: 1, price: 1 }] }), null) // too few points
  assert.equal(fromPersisted({ tool: 'Text', points: [{ timestamp: 1, price: 1 }] }), null) // no text
  assert.equal(fromPersisted({ tool: 'Horizontal', points: [{ timestamp: 1, price: 1 }], visible: false }), null) // hidden in KLine
  assert.equal(fromPersisted({ tool: 'Horizontal', points: [{ timestamp: 'x', price: 1 }] }), null)
})

test('a locked record is drawn but reported locked', () => {
  assert.equal(fromPersisted({ tool: 'Horizontal', points: [{ timestamp: 1, price: 1 }], locked: true }).locked, true)
})

test('a drawing made in KLine (extra points, style) is read by its first points', () => {
  const back = fromPersisted({ tool: 'Trend', points: [{ timestamp: 1, price: 10 }, { timestamp: 2, price: 20 }], style: { color: '#60a5fa', width: 2 } })
  assert.deepEqual(back.spec, { kind: 'trendline', pts: [{ time: 1, price: 10 }, { time: 2, price: 20 }] })
})

test('the signature finds the same drawing whatever its id', () => {
  assert.equal(specSignature({ kind: 'text', pts: [a], text: 'x' }), specSignature({ kind: 'text', pts: [{ ...a }], text: 'x' }))
  assert.notEqual(specSignature({ kind: 'text', pts: [a], text: 'x' }), specSignature({ kind: 'text', pts: [a], text: 'y' }))
  assert.notEqual(specSignature({ kind: 'trendline', pts: [a, b] }), specSignature({ kind: 'rect', pts: [a, b] }))
})

test('drawings kept in the browser before are read back as specs (the old localStorage shapes)', () => {
  const line = (t0, v0, t1, v1) => ({ data: [{ time: t0, value: v0 }, { time: t1, value: v1 }] })
  const saved = [
    { type: 'hline', price: 24410 },
    { type: 'rect', p1: a, p2: b },
    { type: 'text', time: a.time, price: a.price, text: 'Old', color: '#fff' },
    { type: 'trendline', lines: [[{ time: 1, value: 10 }, { time: 2, value: 20 }]] },
    { type: 'fibretracement', series: [line(1, 100, 2, 100), line(1, 125, 2, 125), line(1, 150, 2, 150), line(1, 175, 2, 175), line(1, 200, 2, 200)] },
    { type: 'rrindicator', series: [line(1, 90, 2, 90), line(1, 100, 2, 100), line(1, 110, 2, 110), line(1, 115, 2, 115), line(1, 120, 2, 120)] },
    { type: 'buymarker', series: [{ data: [{ time: 7, value: 55 }] }] },
    { type: 'sellmarker', lines: [[{ time: 8, value: 56 }]] },
    { type: 'channel', lines: [] },
    { type: 'trendline', lines: [] },
    null,
  ]
  const specs = legacyToSpecs(saved, 999)
  assert.deepEqual(specs, [
    { kind: 'hline', pts: [{ time: 999, price: 24410 }] },
    { kind: 'rect', pts: [a, b] },
    { kind: 'text', pts: [a], text: 'Old', color: '#fff' },
    { kind: 'trendline', pts: [{ time: 1, price: 10 }, { time: 2, price: 20 }] },
    { kind: 'fibretracement', pts: [{ time: 1, price: 100 }, { time: 2, price: 200 }] },
    { kind: 'rrindicator', pts: [{ time: 1, price: 90 }, { time: 2, price: 100 }] }, // stop, then entry
    { kind: 'buymarker', pts: [{ time: 7, price: 55 }], text: 'Buy UL' },
    { kind: 'sellmarker', pts: [{ time: 8, price: 56 }], text: 'Sell UL' },
  ])
  assert.deepEqual(legacyToSpecs('nope', 1), [])
})
