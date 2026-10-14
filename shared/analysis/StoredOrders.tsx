import { useState } from 'react'
function Evidence({value}:{value:unknown}) {
  if (value==null) return <span>Unknown</span>
  if (Array.isArray(value)) return <ol>{value.map((item,i)=><li key={i}><Evidence value={item}/></li>)}</ol>
  if (typeof value==='object') return <dl>{Object.entries(value).map(([key,item])=><div key={key}><dt>{key.replace(/_/g,' ')}</dt><dd><Evidence value={item}/></dd></div>)}</dl>
  return <span>{String(value)}</span>
}
function OrderDetails({order}:{order:Record<string,unknown>}) {
  const [open,setOpen]=useState(false)
  return <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>All recorded fields</summary>{open&&<Evidence value={order}/>}</details>
}
export default function StoredOrders({orders}:{orders:Record<string,unknown>[]}) {
  const [open,setOpen]=useState(false),[count,setCount]=useState(50)
  return <details className="analysis-stored-orders" onToggle={event=>setOpen(event.currentTarget.open)}><summary>Stored order history ({orders.length})</summary>{open&&<><p>Read-only records from the committed session. Viewing does not poll or reconcile a broker.</p><table><thead><tr><th>Order</th><th>Broker</th><th>Record source</th><th>Side</th><th>Type</th><th>Quantity</th><th>Status</th><th>Contract</th><th>Details</th></tr></thead><tbody>{orders.slice(0,count).map((order,index)=><tr key={String(order.order_id??index)}><td>{String(order.broker_order_id??order.kotak_order_id??order.order_id??'Unknown')}</td><td>{String(order.execution_broker??(order.kotak_order_id?'kotak':'Unknown'))}</td><td>{order.source==='broker_report'?'Broker report':'Application order'}</td><td>{String(order.side??'Unknown')}</td><td>{String(order.order_type??'Unknown')}</td><td>{String(order.quantity??'Unknown')}</td><td>{String(order.status??'Unknown')}</td><td>{[order.symbol,order.right,order.strike,order.expiry,order.broker_exchange,order.broker_product].filter(v=>v!=null).join(' · ')}</td><td><OrderDetails order={order}/></td></tr>)}</tbody></table>{count<orders.length&&<button onClick={()=>setCount(n=>n+50)}>Load more stored orders</button>}{!orders.length&&<p>No stored order records.</p>}</>}</details>
}
