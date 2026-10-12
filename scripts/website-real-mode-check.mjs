/** Running mode comes from the session even when controls remount or access loads late. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'real-mode-'))
const artifacts = root + '/.cache/real-session-label'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
  import React,{useState} from 'react';import{createRoot}from'react-dom/client';
  import Controls from '${root}/frontend/src/components/SessionControls';
  window.starts=[];
  function Harness(){const[s,setSession]=useState({state:'idle',type:'paper',id:'idle'});
    const[access,setAccess]=useState(true);const[revision,setRevision]=useState(0);
    window.setSession=setSession;window.setAccess=setAccess;window.remount=()=>setRevision(v=>v+1);
    return <Controls key={s.id+':'+revision} sessionState={s.state} activeSessionType={s.type}
      currentSymbol="TATPOW" currentDate="2026-10-09" isRealTradingUser={access}
      onSymbolChange={()=>{}} onDateChange={()=>{}} onOptionsReady={()=>{}}
      onStart={async(time,speed,config)=>{window.starts.push(config);setSession({state:'running',type:config.session_type,id:'started'})}}
      onStop={async()=>setSession(v=>({...v,state:'idle',id:'idle'}))}
      onPause={async()=>{}} onResume={async()=>{}}/>}
  createRoot(document.getElementById('root')).render(<Harness/>);
`, resolveDir: root + '/frontend', loader: 'tsx' }, bundle: true, jsx: 'automatic',
  define: { 'import.meta.env': '{}' }, alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' }, outfile: dir + '/app.js', logLevel: 'silent' })
await writeFile(dir + '/index.html', '<div id="root"></div><script type="module" src="/app.js"></script>')
const server = createServer(async (req, res) => {
  try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) }
  catch { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage(), errors = []
  await page.clock.install({ time: new Date('2026-10-09T05:30:00Z') })
  page.on('pageerror', error => errors.push(String(error)))
  await page.route('**/api/**', route => route.fulfill({ json: { symbols: [{ symbol: 'TATPOW', display_name: 'Tata Power' }], authenticated: true } }))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: 'REAL', exact: true }).click()
  await page.getByRole('button', { name: 'Start Real Trading', exact: true }).click()
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'REAL', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.evaluate(() => window.starts[0].session_type), 'real')
  await page.evaluate(() => window.remount())
  assert.equal(await page.getByRole('button', { name: 'REAL', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.evaluate(() => window.setSession({ state: 'paused', type: 'paper', id: 'paper' }))
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'PAPER', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.evaluate(() => { window.setSession({ state: 'running', type: 'real', id: 'restored' }); window.setAccess(false) })
  await page.getByText('● REAL', { exact: true }).waitFor()
  assert.equal(await page.getByText('● PAPER', { exact: true }).count(), 0)
  await page.evaluate(() => { window.setSession({ state: 'idle', type: 'real', id: 'idle-again' }); window.setAccess(true) })
  await page.getByRole('button', { name: 'Start Paper Trading', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'PAPER', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.deepEqual(errors, [])
  await writeFile(artifacts + '/browser-summary.json', JSON.stringify({ passed: true, checks: ['choose Real then start/remount', 'running Real remains selected', 'remounted Real remains selected', 'paused Paper uses session mode', 'restored Real displays correctly before access lookup', 'fresh idle controls retain Paper default','no page errors'] }, null, 2))
  console.log('Website running session mode acceptance passed')
} finally { await browser.close(); server.close() }
