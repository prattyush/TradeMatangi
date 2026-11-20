/**
 * The only Games routes a client may call, GET and PUT only (spec 3.4): `availability` and `window` (read-only market data,
 * from G1) and `state` (progress). Mirrored by `valid_games_path` in windowsapp/src-tauri/src/lib.rs; parity cases are in
 * windowsapp/src/gamesApi.test.ts and the cargo test `games_allowlist_is_exact_and_method_scoped`. Keep all three in step.
 */
export function validGamesPath(path: string, method: string): boolean {
  const route = path.split('?')[0]
  if (!route || route.startsWith('/') || route.includes('%') || route.includes('#') || route.includes('\\') || route.split('/').some(part => part === '.' || part === '..')) return false
  return (method === 'GET' && (route === 'availability' || route === 'window' || route === 'state')) || (method === 'PUT' && route === 'state')
}
