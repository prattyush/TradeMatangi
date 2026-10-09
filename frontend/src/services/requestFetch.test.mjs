import test from 'node:test'
import assert from 'node:assert/strict'
import { requestFetch } from './requestFetch.ts'

test('network errors identify method and endpoint without request secrets', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  try {
    await assert.rejects(requestFetch('https://backend.example/api/auth/google?token=secret-query', {
      method: 'POST', headers: { Authorization: 'Bearer secret-header' }, body: 'secret-body',
    }), error => {
      assert.match(error.message, /POST https:\/\/backend.example\/api\/auth\/google/)
      assert.match(error.message, /no HTTP response received/)
      assert(!error.message.includes('secret-'))
      return true
    })
  } finally { globalThis.fetch = original }
})

test('abort identity and HTTP responses stay available to existing handlers', async () => {
  const original = globalThis.fetch
  const abort = new DOMException('Cancelled', 'AbortError')
  try {
    globalThis.fetch = async () => { throw abort }
    await assert.rejects(requestFetch('/api/wallet'), error => error === abort)
    const response = new Response('{"detail":"cleanup pending"}', { status: 409 })
    globalThis.fetch = async () => response
    assert.equal(await requestFetch('/api/wallet/reset'), response)
  } finally { globalThis.fetch = original }
})
