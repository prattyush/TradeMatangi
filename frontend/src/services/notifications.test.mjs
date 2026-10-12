import test from 'node:test'
import assert from 'node:assert/strict'
import { clearNotifications, dismissNotification, flashError, flashMessage, flashPatternAlert, getNotifications, markNotificationsRead, NOTIFICATION_LIMIT, setNotificationAccount, setNotificationContext } from './notifications.ts'
const data=new Map()
globalThis.localStorage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}
test.beforeEach(()=>{setNotificationAccount(null);data.clear();setNotificationAccount('alice','test');clearNotifications()})
test.afterEach(()=>setNotificationAccount(null))
test('dismissal preserves timestamp, context and unread history',()=>{
  setNotificationContext({sessionId:'real-session',symbol:'BSESEN',mode:'real'})
  const before=Date.now();flashMessage('Positions timed out','error','Kotak');const entry=getNotifications().records[0]
  assert.ok(entry.lastAt>=before);assert.equal(entry.symbol,'BSESEN');assert.equal(entry.sessionId,'real-session')
  dismissNotification(entry.id);assert.deepEqual(getNotifications().visible,[]);assert.equal(getNotifications().records.length,1)
  markNotificationsRead();assert.equal(getNotifications().records[0].unread,false)
})
test('retry errors group without restarting dismissed flashes',()=>{
  flashMessage('Recovery blocked','error');const id=getNotifications().records[0].id;dismissNotification(id);flashMessage('Recovery blocked','error')
  assert.equal(getNotifications().records.length,1);assert.equal(getNotifications().records[0].count,2);assert.deepEqual(getNotifications().visible,[])
})
test('bounds history and pending errors to the same latest 100 records',()=>{
  for(let i=0;i<140;i++)flashMessage(`Failure ${i}`)
  assert.equal(getNotifications().records.length,NOTIFICATION_LIMIT);assert.equal(getNotifications().visible.length,100);assert.equal(getNotifications().records[0].message,'Failure 139')
})
test('restores account history without replay or cross-account/server leakage',()=>{
  flashMessage('Alice error');setNotificationAccount('bob','test');assert.equal(getNotifications().records.length,0)
  flashMessage('Bob error');setNotificationAccount('alice','test');assert.equal(getNotifications().records[0].message,'Alice error');assert.deepEqual(getNotifications().visible,[])
  setNotificationAccount('alice','other');assert.equal(getNotifications().records.length,0)
})
test('same text in separate sessions remains separate',()=>{
  setNotificationContext({sessionId:'a'});flashMessage('Error');setNotificationContext({sessionId:'b'});flashMessage('Error');assert.equal(getNotifications().records.length,2)
})
test('rejects malformed and expired persisted records',()=>{
  setNotificationAccount(null);data.set('tradematangi_notifications_v1:test:alice',JSON.stringify([{message:'invalid'},{id:'old',message:'old',level:'error',source:'test',firstAt:1,lastAt:1,count:1,unread:true}]))
  setNotificationAccount('alice','test');assert.deepEqual(getNotifications().records,[])
})
test('aborts are silent and API/panel reporting is not double-counted',()=>{
  const abort=new Error('Cancelled');abort.name='AbortError';flashError(abort);flashError(new DOMException('Cancelled','AbortError'));assert.equal(getNotifications().records.length,0)
  const error=new Error('Timeout');flashError(error,'Website request');flashError(error,'Order');flashError('Timeout','Order')
  assert.equal(getNotifications().records.length,1);assert.equal(getNotifications().records[0].count,1)
})
test('storage failure does not break notifications or switching',()=>{
  const original=localStorage.setItem;localStorage.setItem=()=>{throw new Error('Quota')}
  try{flashMessage('Local only');assert.equal(getNotifications().records.length,1);setNotificationAccount('bob','test');assert.equal(getNotifications().records.length,0)}finally{localStorage.setItem=original}
})


test('only errors enter the FIFO, while all message levels remain in history',()=>{
  for(const level of ['info','success','warning','error'])flashMessage(level,level)
  const state=getNotifications()
  assert.equal(state.records.length,4)
  assert.deepEqual(state.visible,[state.records.find(n=>n.level==='error').id])
})
test('queued errors get eight seconds each instead of expiring while waiting', t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()})
  flashMessage('First error');const first=getNotifications().visible[0]
  t.mock.timers.tick(7000)
  flashMessage('Second error');const second=getNotifications().visible[1]
  t.mock.timers.tick(1000)
  assert.deepEqual(getNotifications().visible,[second])
  assert.equal(getNotifications().records.find(n=>n.id===first).message,'First error')
  t.mock.timers.tick(7999);assert.deepEqual(getNotifications().visible,[second])
  t.mock.timers.tick(1);assert.deepEqual(getNotifications().visible,[])
  assert.equal(getNotifications().records.length,2)
})
test('repeating active errors increments counts without restarting the clock', t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()})
  flashMessage('Repeated');flashMessage('Next')
  t.mock.timers.tick(7000);flashMessage('Repeated')
  assert.equal(getNotifications().records.find(n=>n.message==='Repeated').count,2)
  assert.equal(getNotifications().visible.length,2)
  t.mock.timers.tick(1000)
  assert.equal(getNotifications().records.find(n=>n.id===getNotifications().visible[0]).message,'Next')
})
test('dismissal advances the next error and clearing cancels every pending error', t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()})
  flashMessage('First');flashMessage('Second')
  const first=getNotifications().visible[0],second=getNotifications().visible[1]
  dismissNotification(first);assert.deepEqual(getNotifications().visible,[second])
  clearNotifications();t.mock.timers.tick(20000)
  assert.deepEqual(getNotifications(),{records:[],visible:[]})
})
test('account switch cancels the pending queue and restored history is silent', t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()})
  flashMessage('Alice one');flashMessage('Alice two');setNotificationAccount('bob','test')
  flashMessage('Bob one');t.mock.timers.tick(8000)
  assert.deepEqual(getNotifications().visible,[])
  assert.equal(getNotifications().records[0].message,'Bob one')
  setNotificationAccount('alice','test');assert.equal(getNotifications().records.length,2)
  assert.deepEqual(getNotifications().visible,[])
})
test('pattern alerts keep their details in history and only critical ones enter the error queue',()=>{
  for(const severity of ['info','warning','critical'])flashPatternAlert({title:severity,description:'detail',pattern:'Breakout',category:'level',trade_suggestion:'suggestion',severity})
  const state=getNotifications()
  assert.deepEqual(state.records.map(n=>n.level),['error','warning','info'])
  assert.match(state.records[0].message,/critical\nPattern: Breakout\nCategory: level\ndetail\nsuggestion/)
  assert.deepEqual(state.visible,[state.records[0].id])
})
