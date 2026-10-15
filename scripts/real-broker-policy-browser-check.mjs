/** Shared Admin switch used by both clients; synthetic persistence only. */
import {resolve} from 'node:path';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(new URL('..',import.meta.url).pathname);
const {build}=await import(resolve(root,'frontend/node_modules/esbuild/lib/main.js'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const dir=await mkdtemp(tmpdir()+'/broker-policy-');
await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import Setting from'${root}/shared/RealBrokerRestrictionSetting';window.calls=[];window.enabled=false;window.fail=false;const request=async(method,body)=>{window.calls.push({method,body});if(window.fail)throw Error('Could not save setting');if(method==='PUT')window.enabled=body.enabled;return{enabled:window.enabled}};createRoot(document.getElementById('root')).render(<Setting request={request}/>);`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<div id="root"></div><script src="/app.js"></script>');
const server=createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(await readFile(dir+(req.url==='/app.js'?'/app.js':'/index.html')))});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:'+server.address().port);
 const checkbox=page.getByRole('checkbox',{name:'Enforce Real broker session restrictions (Day and Swing)',exact:true});
 await checkbox.waitFor();await page.waitForFunction(()=>!document.querySelector('input').disabled);
 assert.equal(await checkbox.isChecked(),false);
 await checkbox.check();await page.waitForFunction(()=>window.enabled===true&&!document.querySelector('input').disabled);
 assert.equal(await checkbox.isChecked(),true);
 await page.evaluate(()=>{window.fail=true});await checkbox.click();await page.getByRole('alert').waitFor();
 assert.equal(await checkbox.isChecked(),true);
 await page.evaluate(()=>{window.fail=false});await checkbox.uncheck();await page.waitForFunction(()=>window.enabled===false&&!document.querySelector('input').disabled);
 assert.equal(await checkbox.isChecked(),false);assert.deepEqual(errors,[]);
 assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.method==='PUT').map(c=>c.body.enabled)),[true,false,false]);
 console.log('Admin switch: defaults off; saves on/off; failed save retains persisted state; retry succeeds; no browser errors.');
}finally{await browser.close();await new Promise(done=>server.close(done))}
