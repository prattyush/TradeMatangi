import { flashError, getNotificationContext, getNotificationScope } from './notifications';
import { BACKEND_URL } from "../config";
import { _authHeaders } from "./api";
import type { PerformanceFilters, PerformanceReport, PerformanceCycle, RealFeesDay } from '../../../shared/analysis/performance'
export * from '../../../shared/analysis/performance'
async function rawRequest<T>(
  path: string,
  filters: PerformanceFilters,
  signal?: AbortSignal,
): Promise<T> {
  const params = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => Boolean(value)),
  );
  const response = await fetch(
    `${BACKEND_URL}/api/analysis/performance${path}?include_shared=true&${params}`,
    { headers: _authHeaders(), signal },
  );
  if (!response.ok)
    throw new Error(
      `Analytics could not load (${response.status}). Retry when the backend is available.`,
    );
  return response.json() as Promise<T>;
}
async function request<T>(path: string, filters: PerformanceFilters, signal?: AbortSignal): Promise<T> {
  const scope = getNotificationScope(); const context = getNotificationContext();
  try { return await rawRequest<T>(path, filters, signal) }
  catch (error) { if (scope === getNotificationScope()) flashError(error, 'Analysis', context); throw error }
}
export const getPerformance = (
  filters: PerformanceFilters,
  signal?: AbortSignal,
) => request<PerformanceReport>("", filters, signal);
export const getPerformanceCycles = (
  filters: PerformanceFilters,
  offset = 0,
  signal?: AbortSignal,
) =>
  request<{
    items: PerformanceCycle[];
    total: number;
    next_offset: number | null;
  }>("/cycles", { ...filters, offset: String(offset) }, signal);
export const getPerformanceDetail = (
  cycle: PerformanceCycle,
  enrich = false,
  signal?: AbortSignal,
) =>
  request<PerformanceCycle>(
    `/cycles/${cycle.cycle_id}`,
    { session_id: cycle.session_id, enrich: String(enrich) },
    signal,
  );

async function realFeesRequest(date: string, method = 'GET', account = '', amount?: number, signal?: AbortSignal, execution_broker?: "kotak" | "kite"): Promise<RealFeesDay> {
  const params = new URLSearchParams({date, ...(method === 'DELETE' ? {account_id: account, ...(execution_broker ? {execution_broker} : {})} : {})})
  const response = await fetch(`${BACKEND_URL}/api/analysis/performance/real-fees?${params}`, {
    method, signal, headers: {..._authHeaders(), 'Content-Type': 'application/json'},
    body: method === 'POST' ? JSON.stringify({date, account_id: account, actual_total: amount, ...(execution_broker ? {execution_broker} : {})}) : undefined,
  })
  if (!response.ok) { const body = await response.json().catch(()=>({})); throw new Error(typeof body.detail === 'string' ? body.detail : `Real charges update failed (${response.status})`) }
  return response.json()
}
export const getRealFees = (date: string, signal?: AbortSignal) => realFeesRequest(date, 'GET', '', undefined, signal)
export const saveRealFees = (date: string, account: string, amount: number, broker?: "kotak" | "kite") => realFeesRequest(date, 'POST', account, amount, undefined, broker)
export const deleteRealFees = (date: string, account: string, broker?: "kotak" | "kite") => realFeesRequest(date, 'DELETE', account, undefined, undefined, broker)
