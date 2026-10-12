import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { clearNotifications, dismissNotification, flashError, flushNotifications, getNotifications, markNotificationsRead, subscribeNotifications } from '../services/notifications'
import './notifications.css'
export interface HistoryRequest { notificationId?: string }

export function NotificationHeadline({ onOpenHistory }: {onOpenHistory: (id?: string) => void}) {
  const state=useSyncExternalStore(subscribeNotifications,getNotifications)
  const active=state.records.find(item=>item.id===state.visible[0])
  const unread=state.records.filter(item=>item.unread&&(item.level==='error'||item.level==='warning')).length
  return <div className="notification-header" aria-label="Trading messages">
    {active ? <button className="notification-headline" title={active.message} aria-label="Read current error message" onClick={()=>onOpenHistory(active.id)}><span aria-live="polite" aria-atomic="true">{active.source} · {active.message.split(/\r?\n/)[0]}{active.count>1?` ×${active.count}`:''}</span></button> : <span className="notification-headline-empty" />}
    <button className="notification-toggle" aria-label={`Message history${unread?`, ${unread} unread alerts`:''}`} title="Message history · latest 100 messages" onClick={()=>onOpenHistory()}>⚠{unread>0&&<span>{unread}</span>}</button>
    <button className="notification-dismiss" aria-label="Dismiss message" disabled={!active} style={{visibility:active?'visible':'hidden'}} onClick={()=>{if(active)dismissNotification(active.id)}}>×</button>
  </div>
}

const time = (timestamp: number) => new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
export default function NotificationCenter({ request, onRequestChange, showLauncher=true }: {request?: HistoryRequest | null; onRequestChange?: (request:HistoryRequest|null)=>void; showLauncher?:boolean}) {
  const state=useSyncExternalStore(subscribeNotifications,getNotifications)
  const [ownRequest,setOwnRequest]=useState<HistoryRequest|null>(null); const [errorsOnly,setErrorsOnly]=useState(false)
  const selection=request===undefined?ownRequest:request
  const setSelection=onRequestChange??setOwnRequest
  const open=selection!=null
  useEffect(()=>{
    if(!selection)return
    markNotificationsRead()
    if(!selection.notificationId)return
    setErrorsOnly(false)
    const id=selection.notificationId
    const frame=requestAnimationFrame(()=>document.getElementById(`message-${id}`)?.scrollIntoView({block:'nearest'}))
    return()=>cancelAnimationFrame(frame)
  },[selection])
  useEffect(() => {
    const onError = (event: ErrorEvent) => flashError(event.error ?? event.message, 'Website')
    const onRejection = (event: PromiseRejectionEvent) => flashError(event.reason, 'Website')
    window.addEventListener('pagehide', flushNotifications)
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection)
    return () => { window.removeEventListener('pagehide', flushNotifications); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
  }, [])
  useEffect(()=>{if(!open)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();setSelection(null)}};document.addEventListener('keydown',close,true);return()=>document.removeEventListener('keydown',close,true)},[open,setSelection])
  const download=()=>{const blob=new Blob([JSON.stringify(state.records,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`tradematangi-messages-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  return <>
    {showLauncher&&<div className="notification-standalone"><NotificationHeadline onOpenHistory={id=>{setSelection({notificationId:id})}} /></div>}
    {createPortal(<>
      {open&&<section className="notification-history" role="dialog" aria-modal="false" aria-label="Message history"><header><strong>Message history</strong><button aria-label="Close message history" onClick={()=>setSelection(null)}>×</button></header><p>Latest 100 messages · saved in this browser for 7 days · times in IST</p><nav><label><input type="checkbox" checked={errorsOnly} onChange={e=>setErrorsOnly(e.target.checked)}/> Errors / warnings only</label><button onClick={download} disabled={!state.records.length}>Download</button><button onClick={()=>{if(confirm('Clear message history for this account in this browser?'))clearNotifications()}} disabled={!state.records.length}>Clear</button><button onClick={markNotificationsRead}>Mark read</button></nav><div className="notification-history-list">{state.records.filter(n=>!errorsOnly||n.level==='error'||n.level==='warning').map(n=><article id={`message-${n.id}`} key={n.id} className={`notification-${n.level}`}><strong>{n.source} · {n.level}{n.count>1?` · ${n.count} occurrences`:''}{n.unread?' · unread':''}</strong><time>{time(n.lastAt)} IST</time><p>{n.message}</p>{n.count>1&&<small>First: {time(n.firstAt)} IST</small>}{n.sessionId&&<small>{n.symbol} · {n.mode} · Session {n.sessionId}</small>}</article>)}{!state.records.some(n=>!errorsOnly||n.level==='error'||n.level==='warning')&&<p>No messages recorded.</p>}</div></section>}
    </>,document.body)}
  </>
}
