/** Dated practice wallets: active reset guard, completed Stop unlock, DB refresh. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),dir=await mkdtemp(join(tmpdir(),'wallet-settings-')),artifacts=resolve(root,'.cache/dated-wallets-validation')
await mkdir(artifacts,{recursive:true})
await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import Settings from '${root}/frontend/src/components/SettingsModal';import Wallet from '${root}/frontend/src/components/WalletWidget';localStorage.setItem('auth_user',JSON.stringify({userId:'alice'}));function Harness(){const[date,setDate]=useState('2026-10-09');window.changeDate=setDate;const[active,setActive]=useState(false);const[refresh,setRefresh]=useState(0);window.setActive=setActive;return <><Wallet date={date} refreshKey={refresh}/><Settings date={date} sessionActive={active} onWalletReset={()=>{window.walletResets++;setRefresh(v=>v+1)}} onSizingModeChange={()=>{}} onTargetDeviationChange={()=>{}} onBrokerageChange={()=>{}} onStrategySettingsChange={()=>{}}/></>}window.walletResets=0;createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},outfile:dir+'/app.js',logLevel:'silent'})
await writeFile(dir+'/index.html','<div id="root"></div><script type="module" src="/app.js"></script>')
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[],resets=[]
 page.on('pageerror',e=>errors.push(String(e)))
 let active=false;const balances={'2026-10-09':300000,'2020-01-02':200000}
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url())
  if(url.pathname.endsWith('/wallet/reset')){
   resets.push({date:url.searchParams.get('date'),...route.request().postDataJSON()})
   await new Promise(r=>setTimeout(r,150))
   if(active)return route.fulfill({status:409,json:{detail:'Paper session is active or Stop cleanup is incomplete'}})
   balances[url.searchParams.get('date')]=route.request().postDataJSON().amount??150000
   return route.fulfill({status:200,json:{user_id:'alice',date:url.searchParams.get('date'),balance:150000}})
  }
  if(url.pathname.endsWith('/wallet'))return route.fulfill({status:200,json:{user_id:'alice',date:url.searchParams.get('date'),balance:balances[url.searchParams.get('date')],ledger_kind:url.searchParams.get('date')==='2026-10-09'?'paper':'sim',reset_allowed:!active,reset_reason:active?'Paper session is active or Stop cleanup is incomplete':null}})
  await route.fulfill({status:200,json:{settings:{},emails:[],shared_from:[],categories:[],strategies:[],real_trading_enabled:false}})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 const modal=page.getByRole('dialog',{name:'Settings',exact:true})
 await modal.getByRole('button',{name:'general',exact:true}).click()
 const reset=modal.getByRole('button',{name:'Reset to ₹1,50,000',exact:true})
 await modal.getByText('PAPER WALLET — 2026-10-09',{exact:true}).waitFor()
 await page.getByText('₹3,00,000',{exact:false}).first().waitFor()
 // The session starts in another client between the status read and reset.
 active=true
 await reset.click()
 await modal.getByText('Paper session is active or Stop cleanup is incomplete',{exact:true}).first().waitFor()
 assert(await reset.isDisabled())
 assert(await modal.getByPlaceholder('Custom amount').isDisabled())
 await reset.evaluate(node=>node.click());assert.equal(resets.length,1)
 assert.equal(await page.evaluate(()=>window.walletResets),0)
 // Closing and reopening Settings must re-read status after completed Stop.
 await modal.getByRole('button',{name:'Close settings',exact:true}).click()
 active=false
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Reset to ₹1,50,000'&&!b.disabled))
 await modal.getByPlaceholder('Custom amount').fill('180000')
 await modal.getByRole('button',{name:'Set',exact:true}).click()
 await page.waitForFunction(()=>window.walletResets===1)
 await page.getByText('₹1,80,000',{exact:false}).first().waitFor()
 assert.equal(balances['2020-01-02'],200000)
 await page.evaluate(()=>window.changeDate('2020-01-02'))
 await modal.getByText('REPLAY / STEPWISE WALLET — 2020-01-02',{exact:true}).waitFor()
 await page.getByText('₹2,00,000',{exact:false}).first().waitFor()
 await reset.click()
 await page.waitForFunction(()=>window.walletResets===2)
 assert.equal(resets.length,3);assert.equal(resets[2].date,'2020-01-02')
 assert.equal(balances['2026-10-09'],180000)
 await page.evaluate(()=>window.changeDate('2026-10-09'))
 await page.getByText('₹1,80,000',{exact:false}).first().waitFor()
 assert.deepEqual(errors,[])
 await page.screenshot({path:resolve(artifacts,'website-wallet-settings.png')})
 await writeFile(resolve(artifacts,'website-wallet-summary.json'),JSON.stringify({passed:true,checks:['active 409 detail displayed','repeat requests disabled','completed Stop allows same-date reset','wallet refresh uses saved balance','historical selection uses Replay wallet','Paper and Replay resets isolated','no page errors']},null,2))
 console.log('Website wallet Settings acceptance passed')
}finally{await browser.close();server.close()}
