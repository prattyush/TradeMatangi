/** Shared website/desktop lifecycle controls with synthetic broker data only. */
import {resolve} from 'node:path';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(new URL('..',import.meta.url).pathname);
const {build}=await import(resolve(root,'frontend/node_modules/esbuild/lib/main.js'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const dir=await mkdtemp(tmpdir()+'/simple-swing-');
await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import Panel from'${root}/shared/SwingPortfolioPanel';window.calls=[];window.state=localStorage.getItem('synthetic-state')||'running';const portfolio=()=>({session_id:'same-book',mode:'real',execution_broker:'kite',state:window.state,session_capital:50000,guardrail_epoch:0,entries_paused:false});const snapshot=()=>({portfolio:portfolio(),restrictions_enabled:false,positions:[],open_orders:[],pnl:0,wallet_balance:45000,contexts:[]});const request=async(path,method,body)=>{window.calls.push({path,method,body});if(path==='capabilities')return{real_trading_enabled:true};if(path.startsWith('broker-status'))return{broker:'kite',authenticated:true};if(path.endsWith('/close'))window.state='stopped';if(path===''&&method==='POST'){if(body.capital!==50000)throw Error('Missing original capital');window.state='running'}localStorage.setItem('synthetic-state',window.state);return snapshot()};const subscribe=()=>()=>{};const loadSymbols=async()=>[];createRoot(document.getElementById('root')).render(<Panel request={request} subscribe={subscribe} loadSymbols={loadSymbols} onDetach={()=>{}}/>);`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<div id="root"></div><script src="/app.js"></script>');
const server=createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(await readFile(dir+(req.url==='/app.js'?'/app.js':'/index.html')))});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 const page=await browser.newPage();const errors=[];let dialogs=0;
 page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>{dialogs++;void d.dismiss()});
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('combobox',{name:'Swing mode',exact:true}).selectOption('real');
 await page.getByRole('button',{name:'Stop portfolio',exact:true}).click();
 await page.getByRole('button',{name:'Resume portfolio',exact:true}).waitFor();
 assert.equal(await page.getByRole('alertdialog').count(),0);assert.equal(dialogs,0);
 await page.reload();await page.getByRole('combobox',{name:'Swing mode',exact:true}).selectOption('real');
 await page.getByRole('button',{name:'Resume portfolio',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.path===''&&c.method==='POST').length),0);
 await page.getByRole('button',{name:'Resume portfolio',exact:true}).click();
 await page.getByRole('button',{name:'Stop portfolio',exact:true}).waitFor();
 const starts=await page.evaluate(()=>window.calls.filter(c=>c.path===''&&c.method==='POST'));
 assert.equal(starts.length,1);assert.equal(starts[0].body.capital,50000);assert.deepEqual(errors,[]);
 console.log('Shared Swing: no Stop confirmation; stopped book has Resume; same original capital sent on resume; no browser errors.');
}finally{await browser.close();await new Promise(done=>server.close(done))}
