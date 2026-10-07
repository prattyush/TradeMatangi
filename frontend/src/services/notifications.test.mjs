import test from 'node:test'
import assert from 'node:assert/strict'
import { clearNotifications, dismissNotification, flashError, flashMessage, getNotifications, markNotificationsRead, NOTIFICATION_LIMIT, setNotificationAccount, setNotificationContext } from './notifications.ts'
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
  flashMessage('Recovery blocked','warning');const id=getNotifications().records[0].id;dismissNotification(id);flashMessage('Recovery blocked','warning')
  assert.equal(getNotifications().records.length,1);assert.equal(getNotifications().records[0].count,2);assert.deepEqual(getNotifications().visible,[])
})
test('bounds history to 100 and visible messages to 3',()=>{
  for(let i=0;i<140;i++)flashMessage(`Failure ${i}`)
  assert.equal(getNotifications().records.length,NOTIFICATION_LIMIT);assert.equal(getNotifications().visible.length,3);assert.equal(getNotifications().records[0].message,'Failure 139')
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
