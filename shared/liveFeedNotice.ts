export interface FeedStatus {
  selected_provider?: string
  actual_provider?: string | null
  /** `connecting`, `connected`, `reconnecting` or `unavailable`. */
  connection?: string
  reason?: string | null
}

/**
 * The text of the live-feed status line, or null when there is nothing to say. A healthy feed (connected, from the provider the
 * user chose) needs no line: data flowing in is the proof, and the line would only take a row from the chart. It shows while
 * connecting, reconnecting or unavailable, and when the data is coming from a fallback provider.
 */
export function feedNotice(feed: FeedStatus | null | undefined): string | null {
  if (!feed) return null
  const fallback = Boolean(feed.actual_provider && feed.actual_provider !== feed.selected_provider)
  if (feed.connection === 'connected' && !fallback) return null
  const provider = feed.actual_provider ?? feed.selected_provider
  return `Feed ${provider} · ${feed.connection}${fallback ? ` (fallback from ${feed.selected_provider})` : ''}`
}
