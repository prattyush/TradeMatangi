import { BACKEND_URL } from "../config";
import { _authHeaders } from "./api";
import type { PerformanceFilters, PerformanceReport, PerformanceCycle } from '../../../shared/analysis/performance'
export * from '../../../shared/analysis/performance'
async function request<T>(
  path: string,
  filters: PerformanceFilters,
  signal?: AbortSignal,
): Promise<T> {
  const params = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => Boolean(value)),
  );
  const response = await fetch(
    `${BACKEND_URL}/api/analysis/performance${path}?${params}`,
    { headers: _authHeaders(), signal },
  );
  if (!response.ok)
    throw new Error(
      `Analytics could not load (${response.status}). Retry when the backend is available.`,
    );
  return response.json() as Promise<T>;
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
