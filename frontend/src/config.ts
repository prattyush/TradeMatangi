export const BACKEND_URL: string =
  (typeof import.meta !== 'undefined' && (import.meta as { env?: { VITE_BACKEND_URL?: string } }).env?.VITE_BACKEND_URL) ||
  'http://localhost:8700'
