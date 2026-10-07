import './HistorySharingSettings.css'
import { useEffect, useState } from 'react'
export interface HistorySharingState { emails:string[];shared_from:Array<{user_id:string;email:string}> }
export default function HistorySharingSettings({ request }: {request:(method:'GET'|'PUT',emails?:string[])=>Promise<HistorySharingState>}) {
  const [emails,setEmails]=useState('');const [sources,setSources]=useState<HistorySharingState['shared_from']>([])
  const [loaded,setLoaded]=useState(false);const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [saved,setSaved]=useState(false);const [retry,setRetry]=useState(0)
  useEffect(()=>{let current=true;setLoading(true);setLoaded(false);setError('');void request('GET').then(value=>{if(current){setEmails(value.emails.join('\n'));setSources(value.shared_from);setLoaded(true)}}).catch(reason=>{if(current)setError(String(reason))}).finally(()=>{if(current)setLoading(false)});return()=>{current=false}},[request,retry])
  const save=async()=>{if(!loaded)return;setBusy(true);setError('');setSaved(false);try{const value=await request('PUT',emails.split(/[\n,;]/).map(s=>s.trim()).filter(Boolean));setEmails(value.emails.join('\n'));setSources(value.shared_from);setSaved(true)}catch(reason){setError(String(reason))}finally{setBusy(false)}}
  return <section className="history-sharing-settings" aria-label="Real trading history sharing"><h3>Share real trading history</h3><p>Choose registered accounts by email. They can view your complete real-trading order history, executions, analytics, labels, and recorded trading snapshots in Analysis. Past and future real-trading sessions are included. Your paper and replay trades stay private.</p><p>Recipients have read-only access. Removing an email revokes further access. Previously downloaded copies cannot be recalled.</p>
    {loading&&<p role="status">Loading sharing settings…</p>}{error&&<p role="alert">{error}<button onClick={()=>setRetry(n=>n+1)}>Retry sharing settings</button></p>}
    <label>Email addresses, one per line<textarea aria-label="Share real history with emails" value={emails} disabled={!loaded||loading||busy} onChange={e=>{setEmails(e.target.value);setSaved(false)}} rows={4}/></label><button disabled={!loaded||loading||busy} onClick={()=>void save()}>{busy?'Saving…':'Save sharing'}</button>{saved&&<p role="status">History sharing saved.</p>}
    <h4>Real history shared with you</h4>{sources.length ? <ul>{sources.map(source=><li key={source.user_id}>{source.email}</li>)}</ul> : <p>No shared accounts.</p>}
  </section>
}
