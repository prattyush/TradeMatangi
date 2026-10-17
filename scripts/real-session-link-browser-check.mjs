/** Recovery button against a synthetic account; never calls a broker. */
import { resolve } from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(new URL('..',import.meta.url).pathname);
const {build}=await import(resolve(root,'frontend/node_modules/esbuild/lib/main.js'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const dir=await mkdtemp(tmpdir()+'/real-link-');
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import List from '${root}/shared/RealSessionList';window.calls=[];window.failRepair=false;const status={recovery_ready:true,active_sessions:[{session_id:'existing-book',broker:'kotak',trading_style:'intraday',state:'reconnecting',capital:100000}]};const request=async(path,method)=>{window.calls.push({path,method});if(path.endsWith('/repair-identity')){if(window.failRepair)throw new Error('Ownership changed; refresh and retry');return{repaired:true,message:'Session link repaired. Use Reconcile with broker, then resume or close the existing book.'}}if(path.endsWith('/reconcile'))return{verified_flat:true,positions:[],pending_orders:[],message:'Verified'};return status};createRoot(document.getElementById('root')).render(<List request={request}/>);`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<div id="root"></div><script src="/app.js"></script>');
const server=createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(await readFile(dir+(req.url==='/app.js'?'/app.js':'/index.html')))});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('button',{name:'Repair session link',exact:true}).click();
  await page.getByText('Session link repaired.',{exact:false}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(call=>call.method==='POST')),[{path:'existing-book/repair-identity',method:'POST'}]);
  await page.getByText('Capital ₹1,00,000',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Reconcile with broker',exact:true}).click();
  await page.getByText('Broker confirms this book’s scope is flat with no pending orders.',{exact:true}).waitFor();
  await page.evaluate(()=>{window.failRepair=true});
  await page.getByRole('button',{name:'Repair session link',exact:true}).click();
  await page.getByRole('alert').getByText('Ownership changed; refresh and retry',{exact:false}).waitFor();
  await page.getByText('Capital ₹1,00,000',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Repair session link',exact:true}).isEnabled(),true);
  assert.deepEqual(errors,[]);
  console.log('Real session link repair/reconcile, failure recovery and unchanged capital checks passed');
}finally{await browser.close();await new Promise(done=>server.close(done))}
