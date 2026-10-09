/** Verify both existing-session choices start an empty stopped website Paper run. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'website-paper-restart-'))
const artifacts = resolve(root, '.cache/dated-wallets-validation')
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
  import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
  import Controls from '${root}/frontend/src/components/SessionControls';
  import api from '${root}/frontend/src/services/api';
  localStorage.setItem('auth_user',JSON.stringify({userId:'alice'}));
  function Harness(){const[state,setState]=useState('idle');return <Controls
    sessionState={state} currentSymbol="TATPOW" currentDate="2026-10-09"
    lastStartedContext={{symbol:'TATPOW',date:'2026-10-09',sessionType:'paper',instrumentType:'equity'}}
    onSymbolChange={()=>{}} onDateChange={()=>{}} onOptionsReady={()=>{}}
    onPause={async()=>{}} onResume={async()=>{}}
    onStart={async(start_time,speed,config)=>{await api.startSimulation({...config,start_time,speed});setState('running')}}
    onStop={async()=>{await api.stopSimulation('empty-paper');setState('idle')}}/>}
  createRoot(document.getElementById('root')).render(<Harness/>);
`, resolveDir: root + '/frontend', loader: 'tsx' }, bundle: true, jsx: 'automatic',
  define: { 'import.meta.env': '{}' }, alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' },
  outfile: dir + '/app.js', logLevel: 'silent' })
await writeFile(dir + '/index.html', '<div id="root"></div><script type="module" src="/app.js"></script>')
const server = createServer(async (req, res) => {
  try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) }
  catch { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage(), starts = [], stops = [], errors = []
  await page.clock.install({ time: new Date('2026-10-09T05:30:00Z') })
  page.on('pageerror', error => errors.push(String(error)))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/data/symbols')) return route.fulfill({ json: { symbols: [{ symbol: 'TATPOW', name: 'Tata Power' }] } })
    if (path.endsWith('/simulation/check-existing')) return route.fulfill({ json: { exists: true, session: { session_id: 'empty-paper', state: 'ended', trades: [] } } })
    if (path.endsWith('/simulation/start')) { starts.push(request.postDataJSON()); return route.fulfill({ json: { session_id: 'empty-paper', state: 'running', session_capital: 190000, trades: [] } }) }
    if (path.endsWith('/simulation/stop')) { stops.push(request.postDataJSON()); return route.fulfill({ json: { status: 'stopped' } }) }
    await route.fulfill({ json: {} })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  for (const choice of ['No', 'Yes']) {
    await page.getByRole('button', { name: 'Start Paper Trading', exact: true }).click()
    await page.getByRole('button', { name: choice, exact: true }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
    assert.equal(starts.at(-1).session_type, 'paper')
    assert.equal(Boolean(starts.at(-1).override), choice === 'Yes')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
  }
  assert.equal(starts.length, 2)
  assert.equal(stops.length, 2)
  assert(stops.every(body => body.session_id === 'empty-paper'))
  assert.deepEqual(errors, [])
  await writeFile(artifacts + '/website-paper-restart-summary.json', JSON.stringify({ passed: true, checks: ['empty stopped Paper starts with No', 'empty stopped Paper starts with Yes', 'Stop returns to Start', 'no page errors'] }, null, 2))
  console.log('Website empty Paper restart acceptance passed')
} finally { await browser.close(); server.close() }
