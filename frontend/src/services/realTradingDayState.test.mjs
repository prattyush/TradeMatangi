import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRealTradingDayStatus as merge } from './realTradingDayState.ts'
test('late pending response cannot replace confirmed done for the same day',()=>{const done={date:'2026-10-07',state:'done'};assert.equal(merge(done,{date:done.date,state:'closing'}),done);assert.equal(merge(done,{date:done.date,state:'active'}),done)})
test('late active status cannot reenable a closing day',()=>{const closing={date:'2026-10-07',state:'closing'};assert.equal(merge(closing,{date:closing.date,state:'active'}),closing)})
test('a new IST day can become active without unlocking the previous day',()=>{assert.deepEqual(merge({date:'2026-10-07',state:'done'},{date:'2026-10-08',state:'active'}),{date:'2026-10-08',state:'active'})})

test('old-day completion cannot ban the new day in the UI',()=>{const today={date:'2026-10-08',state:'active'};assert.equal(merge(today,{date:'2026-10-07',state:'done'}),today)})
