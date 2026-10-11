/** Built-client Paper Swing controls against synthetic APIs; never live orders. */
import {createServer} from 'node:http'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {resolve,extname} from 'node:path'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname)
const artifacts=resolve(root,'.cache/phase21-swing/browser')
await mkdir(artifacts,{recursive:true})
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html');res.end(await readFile(resolve(root,'windowsapp/dist')+(path==='/'?'/index.html':path)))}catch{res.statusCode=404;res.end()}})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
const page=await browser.newPage({viewport:{width:1400,height:850}}),errors=[],calls=[]
page.on('pageerror',error=>errors.push(String(error)))
let portfolio=null,orders=[],balance=100000
const snapshot=()=>({portfolio,wallet_balance:balance,positions:[],open_orders:orders,pnl:0,guardrail_pnl:0})
const symbols=[{symbol:'CANBK',display_name:'Canara Bank',exchange:'NSE',chart_type:'equity',option_eligible:true,supported_intervals:[1,3,5]},{symbol:'BSESEN',display_name:'SENSEX',exchange:'BSE',chart_type:'index',option_eligible:true,supported_intervals:[1,3,5]}, {symbol:'HDFCBANK',display_name:'HDFC Bank',exchange:'NSE',chart_type:'equity',option_eligible:true,supported_intervals:[1,3,5]}]
try {
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,method=req.method(),body=method==='GET'?{}:req.postDataJSON()||{}
  calls.push({path,method,body});let value={}
  if(path.includes('/swing/portfolios')){
   if(path.endsWith('/contracts/metadata'))value={contracts:[{expiry:'2026-11-03',right:'CE',strike:125.5,lot_size:10}]}
   else if(method==='GET')value=portfolio?.state==='ended'?{portfolio:null}:snapshot()
   else if(path.endsWith('/portfolios')){portfolio={session_id:'portfolio',state:'running',entries_paused:false,session_capital:body.capital,guardrail_epoch:0};balance=body.capital;value=snapshot()}
   else if(path.endsWith('/orders')){orders.push({...body,order_id:'entry',limit_price:body.price});balance-=body.quantity*body.price;value=snapshot()}
   else if(path.endsWith('/cancel')){balance+=orders[0].quantity*orders[0].price;orders=[];value=snapshot()}
   else if(path.endsWith('/pause')){portfolio.entries_paused=body.paused;value=snapshot()}
   else if(path.endsWith('/capital')){portfolio.session_capital=body.capital;portfolio.guardrail_epoch++;value=snapshot()}
   else if(path.endsWith('/close')){portfolio.state='ended';value=snapshot()}
  } else if(path.endsWith('/auth/desktop/token'))value={access_token:'synthetic'}
  else if(path.endsWith('/screens'))value={screens:[]}
  else if(path.endsWith('/catalogue'))value={instruments:symbols}
  else if(path.endsWith('/symbols'))value={symbols}
  else if(path.endsWith('/chart-settings'))value={settings:{}}
  else if(path.endsWith('/historical/pages'))value={candles:[],available:true}
  else if(path.endsWith('/candidate'))value={status:'none',active:null}
  else if(path.endsWith('/wallet'))value={balance:100000,locked:false}
  else if(path.endsWith('/trade-labels/metadata'))value={categories:[],strategies:[],entry_tags:[],exit_tags:[]}
  await route.fulfill({status:200,json:value})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByLabel('Desktop view').selectOption('Swing')
 const panel=page.getByRole('region',{name:'Paper Swing portfolio'})
 await panel.getByRole('button',{name:'Start portfolio'}).click()
 await panel.getByRole('button',{name:'Pause entries'}).waitFor()
 await panel.getByLabel('Limit ₹').fill('100')
 await panel.getByRole('button',{name:'Place intention'}).click()
 await panel.getByRole('button',{name:'Cancel',exact:true}).waitFor()
 assert.equal(balance,99900)
 await panel.getByRole('button',{name:'Cancel',exact:true}).click()
 await panel.getByText('No pending orders.').waitFor()
 assert.equal(balance,100000)
 await panel.getByRole('combobox',{name:'Symbol',exact:true}).fill('CANBK')
 await panel.getByRole('option',{name:'Canara Bank',exact:true}).click()
 await panel.getByLabel('Instrument',{exact:true}).selectOption('options')
 await panel.getByLabel('Strike',{exact:true}).selectOption('125.5')
 await panel.getByText('Lot 10',{exact:true}).waitFor()
 assert.equal(await panel.getByLabel('Quantity',{exact:true}).getAttribute('step'),'10')
 await panel.getByLabel('Quantity',{exact:true}).fill('20')
 await panel.getByLabel('Limit ₹').fill('8')
 await panel.getByRole('button',{name:'Place intention'}).click()
 await panel.getByRole('button',{name:'Cancel',exact:true}).waitFor()
 const optionCall=calls.filter(call=>call.path.endsWith('/orders')).at(-1)
 assert.equal(optionCall.body.strike,125.5);assert.equal(optionCall.body.quantity,20)
 assert.equal(balance,99840)
 await panel.getByRole('button',{name:'Cancel',exact:true}).click()
 await panel.getByText('No pending orders.').waitFor()
 assert.equal(balance,100000)
 await panel.getByRole('button',{name:'Pause entries'}).click()
 await panel.getByRole('button',{name:'Resume entries'}).waitFor()
 assert(await panel.getByRole('button',{name:'Place intention'}).isDisabled())
 await panel.getByRole('button',{name:'Reset capital',exact:true}).click()
 await panel.getByLabel('Capital ₹',{exact:true}).fill('80000')
 await panel.getByRole('button',{name:'Confirm reset'}).click()
 await panel.getByRole('button',{name:'Confirm reset'}).waitFor({state:'hidden'})
 assert.equal(portfolio.session_capital,80000);assert.equal(balance,100000);assert(portfolio.entries_paused)
 await panel.getByRole('button',{name:'Detach screen'}).click()
 await panel.waitFor({state:'hidden'})
 assert.equal(calls.filter(call=>call.path.endsWith('/close')).length,0)
 await page.getByLabel('Desktop view').selectOption('Swing')
 await panel.getByRole('button',{name:'Resume entries'}).waitFor()
 await panel.getByRole('button',{name:'Close portfolio…'}).click()
 await panel.getByRole('button',{name:'Keep portfolio'}).click()
 assert.equal(calls.filter(call=>call.path.endsWith('/close')).length,0)
 await panel.getByRole('button',{name:'Close portfolio…'}).click()
 await panel.getByRole('button',{name:'Confirm close portfolio'}).click()
 await panel.getByText('· ended',{exact:false}).waitFor()
 assert.equal(calls.filter(call=>call.path.endsWith('/close')).length,1)
 await page.screenshot({path:resolve(artifacts,'paper-swing.png')})
 assert.deepEqual(errors,[])
 const result={checks:'start, fully-funded entry, fractional listed options and expiry lot size, cancel refund, pause, selected capital reset, detach/reconnect, confirmed close',errors}
 await writeFile(resolve(artifacts,'summary.json'),JSON.stringify(result,null,2))
 console.log(JSON.stringify(result))
}finally{await browser.close();server.close()}
