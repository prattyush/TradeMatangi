/** Account-local bounded cache; failed/aborted history never becomes an empty page. */
export class AnalysisHistoryCache {
  private entries = new Map<string,{expires:number;size:number;value:Promise<unknown>}>()
  constructor(private maxEntries=32,private maxCandles=100_000,private ttl=600_000) {}
  clear() { this.entries.clear() }
  get<T>(key:string,load:()=>Promise<T>):Promise<T> {
    const cached=this.entries.get(key)
    if(cached&&cached.expires>Date.now()){this.entries.delete(key);this.entries.set(key,cached);return cached.value as Promise<T>}
    if(cached)this.entries.delete(key)
    const entry={expires:Date.now()+this.ttl,size:0,value:Promise.resolve() as Promise<unknown>}
    entry.value=load().then(value=>{
      if(this.entries.get(key)!==entry)return value
      const candles=(value as {candles?:unknown[]})?.candles
      entry.size=Array.isArray(candles)?candles.length:0
      let total=[...this.entries.values()].reduce((sum,item)=>sum+item.size,0)
      while(this.entries.size>this.maxEntries||total>this.maxCandles){const first=this.entries.keys().next().value!;total-=this.entries.get(first)!.size;this.entries.delete(first)}
      return value
    }).catch(error=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw error})
    this.entries.set(key,entry)
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value!)
    return entry.value as Promise<T>
  }
}
