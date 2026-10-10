/** Synthetic native IPC with suspended renderer polling, for Replay wakeup checks. */
export async function installNativeReplayMock(page) {
 await page.addInitScript(() => {
  const callbacks = new Map(), listeners = new Map(), streams = new Map(), replays = new Map(), diagnostics = []
  let sequence = 0, authenticated = false
  const request = async (path, method='GET', body={}) => {
   const response = await fetch(`/api/desktop/v1/${path}`, {method, headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)})
   if(!response.ok)throw new Error(`Native request failed (${response.status})`)
   return response.status===204?null:response.json()
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_,id)=>listeners.delete(id)}
  window.__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:callback=>{const id=++sequence;callbacks.set(id,callback);return id},
   invoke:async(command,args={})=>{
    if(command==='plugin:event|listen'){const id=++sequence;listeners.set(id,args);return id}
    if(command==='plugin:event|unlisten')return listeners.delete(args.eventId)
    if(command==='list_screen_windows')return []
    if(command==='desktop_login'){authenticated=true;return {}}
    if(command.startsWith('desktop_connection_monitor'))return {connection:authenticated?'connected':'authentication_required',revision:0}
    if(command==='record_desktop_renderer_diagnostic'){diagnostics.push(args);return null}
    if(command==='desktop_catalogue')return request('catalogue')
    if(command==='desktop_option_metadata')return request('option-metadata')
    if(command==='desktop_historical_page'||command==='desktop_option_historical_page')return request('historical/pages')
    if(command==='desktop_drawing_request')return request(args.path,args.method,args.body)
    if(command==='desktop_replay_request'){
     const next=await request(`replay/${args.path}`,args.method,args.body)
     if(args.body?.tiles)next.tile_states=args.body.tiles.map(t=>({tile_id:t.tile_id,interval_minutes:t.interval_minutes??3,availability:'available',candle:{timestamp:Math.floor(next.cursor/180)*180,open:100,high:101,low:99,close:100}}))
     replays.set(args.screenId,next)
     return next
    }
    if(command==='desktop_settings_request')return request(`settings/${args.path}`,args.method,args.body)
    if(command==='desktop_get_chart_settings')return request('chart-settings')
    if(command==='start_desktop_stream'){
     if(!streams.has(args.key))streams.set(args.key,args.key.startsWith('replay:')?replays.get(args.key.split(':')[1]):await request(args.snapshotPath))
     return null
    }
    if(command==='desktop_stream_snapshot')return {connection:'connected',last_event_id:streams.get(args.key)?.event_id??streams.get(args.key)?.event_cursor??0,latest_payload:streams.get(args.key)??null,events_dropped:false}
    if(command==='stop_desktop_stream'){streams.delete(args.key);return null}
    return null
   }
  }
  // Model a throttled/background WebView: no 500ms Replay/trading poll can rescue it.
  const interval=window.setInterval.bind(window)
  window.setInterval=(callback,delay,...args)=>delay===500?0:interval(callback,delay,...args)
  window.__replayProbe={streams,diagnostics,
   publish:(key,payload)=>{
    streams.set(key,payload)
    for(const [id,listener] of listeners)if(listener.event===(key.startsWith('replay:')?'desktop-replay-events-available':'desktop-trading-events-available'))callbacks.get(listener.handler)?.({id,event:listener.event,payload:{key,event_id:payload.event_id}})
   }
  }
 })
}
