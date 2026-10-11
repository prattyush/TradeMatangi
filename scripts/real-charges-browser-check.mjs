// Exercise the shared website/desktop editor with controlled authenticated API responses.
import { build } from '../frontend/node_modules/esbuild/lib/main.js';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = resolve('.');
const dir = await mkdtemp(join(tmpdir(), 'real-charges-ui-'));
const artifacts = resolve('.cache/real-analytics-fees');
await mkdir(artifacts, { recursive: true });
await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import Editor from '${root}/shared/analysis/RealChargesEditor';
import {AnalysisProvider} from '${root}/shared/analysis/environment';
let actual=null; window.calls=[]; window.refreshes=0;
const response=date=>({date,accounts:date==='2026-10-09'?[{account_id:'account-A',order_count:2,estimated_total:3,actual_total:actual,history_changed:false}]:[]});
const performance={getRealFees:async date=>response(date),
saveRealFees:async(date,account,amount)=>{window.calls.push({date,account,amount});if(amount===99)throw Error('Storage unavailable');actual=amount;return response(date)},
deleteRealFees:async(date,account)=>{window.calls.push({date,account,remove:true});actual=null;return response(date)}};
createRoot(document.getElementById('root')).render(<AnalysisProvider value={{performance,api:{},onDataChanged:()=>window.refreshes++}}><Editor initialDate='2026-10-09' onSaved={()=>window.refreshes++} onClose={()=>document.body.dataset.closed='yes'}/></AnalysisProvider>);
`, resolveDir: root+'/frontend', loader:'tsx' }, alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'}, jsx:'automatic',bundle:true,outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
const server=createServer(async(req,res)=>{try{res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByText('Calculated estimate ₹3',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'Use estimate'}).isDisabled());
 await page.getByLabel('Actual total charges',{exact:true}).fill('12.34');
 await page.getByRole('button',{name:'Save actual charges'}).click();
 await page.getByText('Actual charges saved; per-trade amounts are allocated',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.refreshes),2);
 assert.deepEqual(await page.evaluate(()=>window.calls[0]),{date:'2026-10-09',account:'account-A',amount:12.34});
 await page.getByRole('button',{name:'Use estimate'}).click();
 await page.getByText('Estimated charges restored',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Actual total charges',{exact:true}).inputValue(),'');
 await page.getByLabel('Actual total charges',{exact:true}).fill('0');
 await page.getByRole('button',{name:'Save actual charges'}).click();
 await page.getByText('Actual charges saved; per-trade amounts are allocated',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.at(-1).amount),0);
 await page.getByLabel('Actual total charges',{exact:true}).fill('99');
 await page.getByRole('button',{name:'Save actual charges'}).click();
 await page.getByRole('alert').filter({hasText:'Storage unavailable'}).waitFor();
 assert.equal(await page.evaluate(()=>window.refreshes),6);
 await page.getByLabel('Charges trading date').fill('2026-10-08');
 await page.getByText(/No Real broker-account trades found/).waitFor();
 assert(await page.getByRole('button',{name:'Save actual charges'}).isDisabled());
 await page.screenshot({path:artifacts+'/charges-editor.png',fullPage:true});
 await page.getByRole('button',{name:'Close charges'}).click();
 assert.equal(await page.evaluate(()=>document.body.dataset.closed),'yes');
 assert.deepEqual(errors,[]);
 console.log('PASS shared Real charges editor: save, exact account/date, revert, zero, storage failure, empty date, close; no page errors');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
