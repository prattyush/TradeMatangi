/** A small ring buffer of recent problems for "Copy diagnostics". It must never hold a secret. */
export interface DiagnosticEntry {
  at: string
  what: string
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/("?(?:access_token|refresh_token|id_token|password)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1"[redacted]"'],
  [/([?&](?:token|access_token|refresh_token|id_token|password)=)[^&\s]+/gi, '$1[redacted]'],
]

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
}

export interface Diagnostics {
  record(what: string): void
  entries(): DiagnosticEntry[]
  clear(): void
}

export function createDiagnostics(limit = 30, now: () => Date = () => new Date()): Diagnostics {
  const items: DiagnosticEntry[] = []
  return {
    record(what) {
      items.push({ at: now().toISOString(), what: redact(String(what)).slice(0, 300) })
      if (items.length > limit) items.splice(0, items.length - limit)
    },
    entries: () => items.slice(),
    clear: () => { items.length = 0 },
  }
}

/** One shared buffer for the whole app. */
export const diagnostics: Diagnostics = createDiagnostics()
