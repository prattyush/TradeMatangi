/** Verify every website renderer still works through the shared, host-supplied chart boundary. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'website-analysis-renderers-'))
const artifacts = root + '/.cache/desktop-analysis-validation'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {withWebsiteAnalysis} from '${root}/frontend/src/services/analysisEnvironment';
import api from '${root}/frontend/src/services/api';
import {AnalysisChart,OptionsChart,AnalysisChartPanel} from '${root}/shared/analysis/TradeAnalysis';
import {SnapshotChart,SnapshotOptionsChart} from '${root}/shared/analysis/EventSnapshotViewer';
import {TradesChart,PatternChart} from '${root}/shared/analysis/PatternVsTradeComparison';
const end=Date.parse('2026-10-07T10:15:00Z')/1000;
const bars=Array.from({length:80},(_,i)=>({time:end-(79-i)*180,open:100+i,high:103+i,low:98+i,close:101+i}));
api.getHistorical=async()=>({candles:bars});api.getPreSession=async()=>bars;
api.getOptionsHistorical=async()=>({candles:bars});api.patternOhlcEquity=async()=>({candles:bars});api.patternOhlcOptions=async()=>({candles:bars});
const renderers={AnalysisChart,OptionsChart,AnalysisChartPanel,SnapshotChart,SnapshotOptionsChart,TradesChart,PatternChart};
const props={symbol:'NIFTY',date:'2026-10-07',trades:[],allTrades:[],isOptions:false,historicalDays:2,
strike:25000,expiry:'2026-10-08',right:'CE',sessionId:'synthetic',observationResolution:1,
barTime:end,barOhlc:{open:179,high:182,low:177,close:180},currentPrice:180,openOrders:[],position:null,filledTrades:[],
getMarkerText:t=>t.side,strikeTabs:[],isOpt:true,annotations:[],topPatterns:{},activeStrategy:null,activeCategory:null,
instFilter:'underlying',setInstFilter:()=>{},patternStrike:{ce:25000,pe:24950,exp:'2026-10-08'}};
const app=createRoot(document.getElementById('root'));
window.showRenderer=name=>{const C=renderers[name];const Host=withWebsiteAnalysis(()=> <C {...props}/>);app.render(<React.StrictMode><Host/></React.StrictMode>)};
`, resolveDir: root + '/frontend', loader: 'tsx' }, bundle: true, jsx: 'automatic', outfile: dir + '/app.js', define: { 'import.meta.env': '{}' }, alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' }, logLevel: 'silent' })
await writeFile(dir + '/index.html', '<html><body style="background:#0d1117"><div id="root" style="display:flex;width:1050px;height:600px"></div><script type="module" src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => { try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) } catch { res.statusCode = 404; res.end() } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } }), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.showRenderer)
  const names = ['AnalysisChart', 'OptionsChart', 'AnalysisChartPanel', 'SnapshotChart', 'SnapshotOptionsChart', 'TradesChart', 'PatternChart']
  for (const name of names) {
    await page.evaluate(name => window.showRenderer(name), name)
    await page.locator('canvas').first().waitFor()
    await page.waitForTimeout(250)
    assert.deepEqual(errors, [], name)
    await page.screenshot({ path: `${artifacts}/website-renderer-${name}.png` })
  }
  await writeFile(artifacts + '/website-renderers-summary.json', JSON.stringify({ passed: true, names, errors }, null, 2))
  console.log('All seven website Analysis renderer slots passed in StrictMode')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
