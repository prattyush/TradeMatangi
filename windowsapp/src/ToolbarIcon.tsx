export function ToolbarIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Refresh: 'M20 7a9 9 0 0 0-15 1 M20 3v5h-5 M4 17a9 9 0 0 0 15-1 M4 21v-5h5',
    Browse: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M16 8l-3 5-5 3 3-5z',
    Paper: 'M8 8a6 6 0 0 0 0 8 M16 8a6 6 0 0 1 0 8 M5 5a10 10 0 0 0 0 14 M19 5a10 10 0 0 1 0 14 M12 11v2',
    Replay: 'M5 7a9 9 0 1 1-1 9 M5 3v5H1 M10 8l6 4-6 4z',
    Stepwise: 'M3 20v-6h6V8h6V3h6',
    Flatten: 'M3 12h18 M12 2v6 M8 4l4 4 4-4 M12 22v-6 M8 20l4-4 4 4',
    Block: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M6 6l12 12',
  }
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
