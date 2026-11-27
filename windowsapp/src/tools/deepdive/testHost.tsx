import type { ReactNode } from 'react'
import { DeepDiveHostProvider, type DeepDiveHost } from '../../../../shared/deepdive/ui/host'
import type { DeepDiveApi } from '../../../../shared/deepdive/types'

/** A host with no behaviour, for rendering a screen once in a test (effects never run in a static render). */
export function stubHost(overrides: Partial<DeepDiveHost> = {}): DeepDiveHost {
  return {
    api: {} as DeepDiveApi,
    names: { categories: async () => [], strategies: async () => [], addCategory: async () => undefined, addStrategy: async () => undefined },
    expiry: async () => '2026-10-13',
    resolveStrikes: async () => ({ ce: 24500, pe: 24400, atm: 24450, expiry: '2026-10-13' }),
    settings: { mode: 'otm', ceCap: 0, peCap: 0, historicalDays: 2, loaded: true },
    Chart: () => null,
    ...overrides,
  }
}

export const WithHost = ({ children, host = stubHost() }: { children: ReactNode; host?: DeepDiveHost }) => <DeepDiveHostProvider host={host}>{children}</DeepDiveHostProvider>
