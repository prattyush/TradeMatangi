export function ToolbarIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Play: 'M8 4l12 8-12 8z',
    Pause: 'M7 4v16 M17 4v16',
    Stop: 'M5 5h14v14H5z',
    Next: 'M4 4l12 8-12 8z M20 4v16',
    Record: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    Snapshot: 'M3 7h4l2-3h6l2 3h4v13H3z M12 9a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    Link: 'M9 14l6-4 M10 7l2-2a4 4 0 0 1 6 6l-2 2 M14 17l-2 2a4 4 0 0 1-6-6l2-2',
    Focus: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M12 8v8 M8 12h8',
    Inspect: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
    Done: 'M4 12l5 5L20 6',
    Detach: 'M9 4H3v16h6 M11 12h10 M17 8l4 4-4 4',
    Logout: 'M10 3H3v18h7 M10 12h11 M17 8l4 4-4 4',
    Real: 'M3 20V4 M3 20h18 M6 16l5-6 4 3 6-9 M17 4h4v4',
    Wallet: 'M3 5h16v3 M3 5v15h18V8H3 M16 12h5v4h-5z',
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
