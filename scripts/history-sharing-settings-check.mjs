/** Real website Settings UI with synthetic sharing responses; no accounts changed. */
import {build} from '../frontend/node_modules/esbuild/lib/main.js'
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),artifacts=root+'/.cache/desktop-analysis-validation',dir=await mkdtemp(join(tmpdir(),'history-sharing-settings-'))
await mkdir(artifacts,{recursive:true})
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Settings from '${root}/frontend/src/components/SettingsModal.tsx';localStorage.setItem('auth_user',JSON.stringify({userId:'alice',email:'alice@example.com'}));createRoot(document.getElementById('root')).render(<Settings date='2026-10-07' isAdmin={false} isRealTradingUser={false} sessionActive={false} onWalletReset={()=>{}} onSizingModeChange={()=>{}} onTargetDeviationChange={()=>{}} onBrokerageChange={()=>{}} onStrategySettingsChange={()=>{}}/>);`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="background:#0d1117"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
let page
try{
 page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];let emails=[],writes=0
 page.on('pageerror',error=>{errors.push(String(error));console.error('Page error',error.message)})
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;let value={}
  if(path.endsWith('/users/real-history-sharing')){
   if(route.request().method()==='PUT'){
    const requested=route.request().postDataJSON().emails
    if(requested.some(email=>!email.includes('@'))){await route.fulfill({status:422,json:{detail:'Invalid email address'}});return}
    emails=[...new Set(requested.map(email=>email.trim().toLowerCase()))];writes++
   }
   value={emails,shared_from:[{user_id:'owner',email:'owner@example.com'}]}
  }else if(path.endsWith('/wallet'))value={balance:100000,date:'2026-10-07'}
  else if(path.endsWith('/auth/me'))value={user_id:'alice',email:'alice@example.com',is_admin:false}
  else if(path.endsWith('/guardrails/settings'))value={settings:{}}
  await route.fulfill({status:200,json:value})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Settings',exact:true}).click()
 const modal=page.getByRole('dialog',{name:'Settings',exact:true})
 await modal.getByRole('button',{name:'sharing',exact:true}).click()
 const input=modal.getByLabel('Share real history with emails');await input.waitFor();await input.fill('BOB@example.com\nbob@example.com')
 await modal.getByRole('button',{name:'Save sharing',exact:true}).click();await modal.getByText('History sharing saved.',{exact:true}).waitFor()
 assert.deepEqual(emails,['bob@example.com']);assert.equal(writes,1)
 await input.fill('invalid');await modal.getByRole('button',{name:'Save sharing',exact:true}).click();await modal.getByRole('alert').filter({hasText:'422'}).waitFor();assert.deepEqual(emails,['bob@example.com'])
 await input.fill('');await modal.getByRole('button',{name:'Save sharing',exact:true}).click();await modal.getByText('History sharing saved.',{exact:true}).waitFor();assert.deepEqual(emails,[])
 await modal.getByText('owner@example.com',{exact:true}).waitFor()
 await page.screenshot({path:artifacts+'/website-history-sharing.png'})
 assert.deepEqual(errors,[])
 await writeFile(artifacts+'/website-sharing-summary.json',JSON.stringify({passed:true,errors,writes,checks:['website settings tab','registered email editing','normalized duplicate email','explicit validation failure','revocation','incoming owner display']},null,2))
 console.log('Website history sharing settings acceptance passed')
}catch(error){if(page){await page.screenshot({path:artifacts+'/sharing-failure.png'});await writeFile(artifacts+'/sharing-failure.html',await page.content())};throw error}finally{await browser.close();await new Promise(r=>server.close(r))}
