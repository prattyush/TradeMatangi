import type { PerformanceCycle } from './performance'
export interface CyclePage {items:PerformanceCycle[];total:number;next_offset:number|null}
/** Export only a complete, coherent pagination traversal; no partial download. */
export async function completeCycleExport(first:PerformanceCycle[],offset:number|null,total:number,load:(offset:number)=>Promise<CyclePage>,signal?:AbortSignal):Promise<PerformanceCycle[]> {
  const rows=[...first];const visited=new Set<number>();const identities=new Set(rows.map(row=>`${row.session_id}:${row.cycle_id}`))
  if(identities.size!==rows.length)throw new Error('Duplicate cycle membership; refresh before exporting')
  while(offset!=null){
    signal?.throwIfAborted()
    if(visited.has(offset)||offset!==rows.length)throw new Error('Cycle pagination changed; refresh before exporting')
    visited.add(offset)
    const page=await load(offset)
    signal?.throwIfAborted()
    if(page.total!==total||!page.items.length)throw new Error('Cycle export changed or is incomplete; refresh and retry')
    for(const row of page.items){const key=`${row.session_id}:${row.cycle_id}`;if(identities.has(key))throw new Error('Duplicate cycle during export; refresh and retry');identities.add(key);rows.push(row)}
    offset=page.next_offset
  }
  signal?.throwIfAborted()
  if(rows.length!==total)throw new Error('Cycle export is incomplete; refresh and retry')
  return rows
}
