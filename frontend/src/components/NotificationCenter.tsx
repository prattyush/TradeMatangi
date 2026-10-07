import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { clearNotifications, dismissNotification, flashError, flushNotifications, getNotifications, markNotificationsRead, subscribeNotifications } from '../services/notifications'
import './notifications.css'
const time = (timestamp: number) => new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
export default function NotificationCenter() {
  const state=useSyncExternalStore(subscribeNotifications,getNotifications)
  const [open,setOpen]=useState(false); const [errorsOnly,setErrorsOnly]=useState(false)
  useEffect(() => {
    const onError = (event: ErrorEvent) => flashError(event.error ?? event.message, 'Website')
    const onRejection = (event: PromiseRejectionEvent) => flashError(event.reason, 'Website')
    window.addEventListener('pagehide', flushNotifications)
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection)
    return () => { window.removeEventListener('pagehide', flushNotifications); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
  }, [])
  const unread=state.records.filter(n=>n.unread&&(n.level==='error'||n.level==='warning')).length
  useEffect(()=>{if(!open)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();setOpen(false)}};document.addEventListener('keydown',close,true);return()=>document.removeEventListener('keydown',close,true)},[open])
  const download=()=>{const blob=new Blob([JSON.stringify(state.records,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`tradematangi-messages-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  return <>
    <button className="notification-toggle" aria-label={`Message history${unread?`, ${unread} unread errors`:''}`} title="Message history · latest 100 messages" aria-expanded={open} onClick={()=>{setOpen(value=>!value);markNotificationsRead()}}>⚠{unread>0&&<span>{unread}</span>}</button>
    {createPortal(<>
      <div className="notification-flashes" aria-live="polite" aria-relevant="additions text">{state.visible.map(id=>{const item=state.records.find(n=>n.id===id);return item&&<section key={id} className={`notification-card notification-${item.level}`}><button aria-label="Dismiss message" onClick={()=>dismissNotification(id)}>×</button><strong>{item.source}{item.count>1?` ×${item.count}`:''}</strong><p>{item.message}</p><small>{time(item.lastAt)} IST</small></section>})}</div>
      {open&&<section className="notification-history" role="dialog" aria-modal="false" aria-label="Message history"><header><strong>Message history</strong><button aria-label="Close message history" onClick={()=>setOpen(false)}>×</button></header><p>Latest 100 messages · saved in this browser for 7 days · times in IST</p><nav><label><input type="checkbox" checked={errorsOnly} onChange={e=>setErrorsOnly(e.target.checked)}/> Errors / warnings only</label><button onClick={download} disabled={!state.records.length}>Download</button><button onClick={()=>{if(confirm('Clear message history for this account in this browser?'))clearNotifications()}} disabled={!state.records.length}>Clear</button><button onClick={markNotificationsRead}>Mark read</button></nav><div className="notification-history-list">{state.records.filter(n=>!errorsOnly||n.level==='error'||n.level==='warning').map(n=><article key={n.id} className={`notification-${n.level}`}><strong>{n.source} · {n.level}{n.count>1?` · ${n.count} occurrences`:''}{n.unread?' · unread':''}</strong><time>{time(n.lastAt)} IST</time><p>{n.message}</p>{n.count>1&&<small>First: {time(n.firstAt)} IST</small>}{n.sessionId&&<small>{n.symbol} · {n.mode} · Session {n.sessionId}</small>}</article>)}{!state.records.some(n=>!errorsOnly||n.level==='error'||n.level==='warning')&&<p>No messages recorded.</p>}</div></section>}
    </>,document.body)}
  </>
}
