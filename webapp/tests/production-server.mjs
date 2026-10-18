import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
const root = resolve('dist')
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' }
createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Existing website</title>Existing website'); return }
  // Keep tests independent of a real broker/backend.
  if (pathname.startsWith('/api/') || pathname.startsWith('/ai/')) {
    response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"detail":"Test backend unavailable"}')
    return
  }
  if (!pathname.startsWith('/webapp/')) { response.writeHead(404).end(); return }
  const file = resolve(root, pathname.slice('/webapp/'.length) || 'index.html')
  if (!file.startsWith(`${root}/`)) { response.writeHead(403).end(); return }
  try {
    let data = await readFile(file)
    // Simulate a real deployment with changed worker bytes and offline cache version.
    if (pathname === '/webapp/sw.js' && new URL(request.url, 'http://localhost').searchParams.get('version') === '2') {
      data = Buffer.from(data.toString().replace('tradematangi-webapp-offline-v1', 'tradematangi-webapp-offline-v2'))
    }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data)
  } catch { response.writeHead(404).end() }
}).listen(5175, '127.0.0.1')
