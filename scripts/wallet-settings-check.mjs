/** Settings wallet reset errors must explain day locks, not hide HTTP details. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),dir=await mkdtemp(join(tmpdir(),'wallet-settings-')),artifacts=resolve(root,'.cache/desktop-paper-wallet-fix')
await mkdir(artifacts,{recursive:true})
await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import Settings from '${root}/frontend/src/components/SettingsModal';localStorage.setItem('auth_user',JSON.stringify({userId:'alice'}));function Harness(){const[date,setDate]=useState('2026-10-09');window.changeDate=setDate;window.walletResets=0;return <Settings date={date} sessionActive={false} onWalletReset={()=>window.walletResets++} onSizingModeChange={()=>{}} onTargetDeviationChange={()=>{}} onBrokerageChange={()=>{}} onStrategySettingsChange={()=>{}}/>}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},outfile:dir+'/app.js',logLevel:'silent'})
await writeFile(dir+'/index.html','<div id="root"></div><script type="module" src="/app.js"></script>')
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[],resets=[]
 page.on('pageerror',e=>errors.push(String(e)))
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url())
  if(url.pathname.endsWith('/wallet/reset')){
   resets.push({date:url.searchParams.get('date'),...route.request().postDataJSON()})
   await new Promise(r=>setTimeout(r,150))
   if(url.searchParams.get('date')==='2026-10-09')return route.fulfill({status:409,json:{detail:'Paper wallet is locked after the first session starts'}})
   return route.fulfill({status:200,json:{user_id:'alice',date:url.searchParams.get('date'),balance:150000}})
  }
  await route.fulfill({status:200,json:{settings:{},emails:[],shared_from:[],categories:[],strategies:[],real_trading_enabled:false}})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 const modal=page.getByRole('dialog',{name:'Settings',exact:true})
 await modal.getByRole('button',{name:'general',exact:true}).click()
 const reset=modal.getByRole('button',{name:'Reset to ₹1,50,000',exact:true})
 await reset.click()
 await modal.getByText('Paper wallet is locked after the first session starts',{exact:true}).waitFor()
 assert(await reset.isDisabled())
 assert(await modal.getByPlaceholder('Custom amount').isDisabled())
 await reset.evaluate(node=>node.click());assert.equal(resets.length,1)
 assert.equal(await page.evaluate(()=>window.walletResets),0)
 await page.evaluate(()=>window.changeDate('2026-10-10'))
 await reset.waitFor();await reset.click()
 await modal.getByText('Reset to ₹1,50,000',{exact:true}).last().waitFor()
 await page.waitForFunction(()=>window.walletResets===1)
 assert.equal(resets.length,2);assert.equal(resets[1].date,'2026-10-10')
 assert.deepEqual(errors,[])
 await page.screenshot({path:resolve(artifacts,'website-wallet-settings.png')})
 await writeFile(resolve(artifacts,'website-wallet-summary.json'),JSON.stringify({passed:true,checks:['backend 409 detail displayed','locked date repeat requests disabled','different date reset allowed','success callback only on successful reset','no page errors']},null,2))
 console.log('Website wallet Settings acceptance passed')
}finally{await browser.close();server.close()}
