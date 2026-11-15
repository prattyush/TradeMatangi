import { ApiError, isForbidden, isMissingEndpoint } from './errors'
import type { ApiClient } from './transport'

/**
 * What this server can do. The app is used against `dev`, `preprod` and feature-branch servers, so every screen must
 * cope with a feature the server does not have. `status` says how the probe itself went.
 */
export type ServerStatus = 'ok' | 'old' | 'forbidden' | 'unreachable' | 'unknown'

export interface Capabilities {
  status: ServerStatus
  apiVersion: string | null
  features: string[]
  tradingCapabilities: string[]
}

export const EMPTY_CAPABILITIES: Capabilities = { status: 'unknown', apiVersion: null, features: [], tradingCapabilities: [] }

interface CapabilitiesResponse {
  api_version?: string
  features?: string[]
  trading_capabilities?: string[]
}

export async function probeCapabilities(client: ApiClient, signal?: AbortSignal): Promise<Capabilities> {
  try {
    const body = await client.get<CapabilitiesResponse>('/api/desktop/v1/capabilities', undefined, { signal, retries: 1, timeoutMs: 10_000 })
    return {
      status: 'ok',
      apiVersion: body.api_version ?? null,
      features: Array.isArray(body.features) ? body.features : [],
      tradingCapabilities: Array.isArray(body.trading_capabilities) ? body.trading_capabilities : [],
    }
  } catch (error) {
    if (isMissingEndpoint(error)) return { ...EMPTY_CAPABILITIES, status: 'old' }
    if (isForbidden(error)) return { ...EMPTY_CAPABILITIES, status: 'forbidden' }
    if (error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout')) return { ...EMPTY_CAPABILITIES, status: 'unreachable' }
    throw error
  }
}

export const hasTradingCapability = (capabilities: Capabilities, name: string): boolean => capabilities.tradingCapabilities.includes(name)

/** One line for Settings > About. */
export function summarizeCapabilities(capabilities: Capabilities): string {
  switch (capabilities.status) {
    case 'ok': return `API ${capabilities.apiVersion ?? '?'}, ${capabilities.features.length} features, ${capabilities.tradingCapabilities.length} trading capabilities`
    case 'old': return 'Older server: no capabilities endpoint'
    case 'forbidden': return 'Not permitted for this account'
    case 'unreachable': return 'Server not reachable'
    default: return 'Not checked yet'
  }
}
