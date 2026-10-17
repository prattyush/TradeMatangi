/** Desktop launcher occupies header space; history still records full errors. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(tmpdir() + '/desktop-notification-icon-')
const artifacts = root + '/.cache/swing-layout'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import Center,{NotificationIcon}from'${root}/shared/NotificationCenter';import{flashError,flashMessage,setNotificationAccount,flushNotifications}from'${root}/shared/notifications';import{createChart}from'lightweight-charts';import '${root}/windowsapp/src/styles.css';
setNotificationAccount('fixture','desktop-icon');window.notify=message=>flashError(message,'Desktop trading');window.warn=()=>flashMessage('Recovery warning','warning','Desktop');window.flush=flushNotifications;
function Harness(){const[request,setRequest]=useState(null);return <><main><header><select aria-label='Desktop view'><option>Workspace</option></select><NotificationIcon onOpenHistory={()=>setRequest({})}/></header><section id='chart'/></main><Center source='Desktop' request={request} onRequestChange={setRequest} showLauncher={false}/></>};createRoot(document.getElementById('root')).render(<Harness/>);
setTimeout(()=>{const chart=createChart(document.getElementById('chart'),{autoSize:true,layout:{background:{color:'#10131a'},textColor:'#dce5ef'},rightPriceScale:{visible:true}});chart.addCandlestickSeries().setData(Array.from({length:30},(_,i)=>({time:1700000000+i*180,open:100+i,high:105+i,low:98+i,close:103+i})));window.chartReady=true;},100);`, resolveDir: root + '/frontend', loader: 'tsx' }, bundle: true, jsx: 'automatic', outfile: dir + '/app.js', alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent' })
await writeFile(dir + '/index.html', '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => {
  try { const path = dir + (req.url.startsWith('/app') ? req.url : '/index.html'); res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(path)) }
  catch { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.waitForFunction(() => window.chartReady)
  const chart = await page.locator('#chart').boundingBox()
  const launcher = page.getByRole('button', { name: /^Message history/ })
  assert.equal(await page.locator('.notification-standalone').count(), 0)
  const bounds = await launcher.boundingBox()
  assert.ok(bounds.width <= 36 && bounds.height <= 36)
  assert.ok(bounds.y + bounds.height <= chart.y)
  assert.equal(await page.locator('.notification-headline-empty').count(), 0)
  await page.evaluate(() => { window.notify('Order failed\nFull diagnostic details'); window.warn() })
  await page.getByRole('button', { name: 'Message history, 2 unread alerts' }).waitFor()
  assert.deepEqual(await launcher.boundingBox(), bounds, 'Errors must not resize the launcher')
  assert.equal(await page.evaluate(() => { const r=document.getElementById('chart').getBoundingClientRect();return document.getElementById('chart').contains(document.elementFromPoint(r.right-5,r.bottom-15)) }), true, 'Right price scale must remain unobstructed')
  await launcher.focus(); await launcher.press('Enter')
  const history = page.getByRole('dialog', { name: 'Message history' })
  await history.waitFor(); assert.match(await history.innerText(), /Full diagnostic details/)
  assert.match(await history.innerText(), /Recovery warning/)
  const downloading = page.waitForEvent('download')
  await history.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await downloading
  assert.equal(JSON.parse(await readFile(await download.path(), 'utf8')).length, 2)
  await page.keyboard.press('Escape'); await history.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Message history', exact: true }).waitFor()
  await page.evaluate(() => window.flush()); await page.reload(); await page.waitForFunction(() => window.chartReady)
  await launcher.click(); assert.match(await history.innerText(), /Full diagnostic details/)
  await history.getByRole('button', { name: 'Close message history' }).click()
  await page.screenshot({ path: artifacts + '/desktop-header-notification.png' })
  assert.deepEqual(errors, [])
  console.log('Desktop header-only icon, clear price scale, unread/history/download/reload and keyboard checks passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
