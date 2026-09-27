export interface GuardrailFeedback { type: 'BLOCK' | 'COOLDOWN' | 'BAN'; reason: string }

export function parseGuardrailError(error: unknown): GuardrailFeedback | null {
  const match = String(error).match(/GUARDRAIL:(BLOCK|COOLDOWN|BAN):([^"\n]*)/)
  return match ? { type: match[1] as GuardrailFeedback['type'], reason: match[2].trim() } : null
}
