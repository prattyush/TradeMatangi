import { describe, expect, it } from 'vitest'
import { createServerConfig, normalizeServerUrl, BUILD_SERVER_URL } from './serverConfig'
import { createMemoryStore } from './storage'

describe('normalizeServerUrl', () => {
  it('adds https and keeps only the origin', () => {
    expect(normalizeServerUrl('tradematangi.co.in')).toBe('https://tradematangi.co.in')
    expect(normalizeServerUrl('  https://tradematangi.co.in/  ')).toBe('https://tradematangi.co.in')
    expect(normalizeServerUrl('https://tradematangi.co.in/api/x?y=1')).toBe('https://tradematangi.co.in')
    expect(normalizeServerUrl('https://example.com:8443')).toBe('https://example.com:8443')
  })
  it('refuses plain http unless the build allows it', () => {
    expect(() => normalizeServerUrl('http://10.0.0.5:8700', { allowHttp: false })).toThrow(/https/)
    expect(normalizeServerUrl('http://10.0.0.5:8700', { allowHttp: true })).toBe('http://10.0.0.5:8700')
  })
  it('refuses other schemes, empty input and embedded credentials', () => {
    expect(() => normalizeServerUrl('ftp://x.com')).toThrow()
    expect(() => normalizeServerUrl('   ')).toThrow(/Enter/)
    expect(() => normalizeServerUrl('https://user:pass@x.com')).toThrow(/user name/)
    expect(() => normalizeServerUrl('javascript:alert(1)')).toThrow()
  })
})

describe('server config', () => {
  it('defaults to the production server and remembers a change', async () => {
    const config = createServerConfig(createMemoryStore())
    expect(await config.get()).toBe(BUILD_SERVER_URL)
    expect(await config.set('preprod.example.com')).toBe('https://preprod.example.com')
    expect(await config.get()).toBe('https://preprod.example.com')
    expect(await config.reset()).toBe(BUILD_SERVER_URL)
  })
  it('ignores a saved value that is no longer valid', async () => {
    const config = createServerConfig(createMemoryStore({ 'tm.server_url': 'not a url ::' }))
    expect(await config.get()).toBe(BUILD_SERVER_URL)
  })
})
