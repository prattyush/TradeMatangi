import { BACKEND_URL } from "../config";
export type WebsiteChartRenderer = "lightweight" | "kline";
export function rendererAccountKey() {
  try {
    return `${BACKEND_URL}:${JSON.parse(localStorage.getItem("auth_user") ?? "null")?.userId ?? ""}`;
  } catch {
    return `${BACKEND_URL}:`;
  }
}
export const rendererCacheKey = (owner = rendererAccountKey()) =>
  `website-chart-renderer:${owner}`;
const values = new Map<
  string,
  { version: number; renderer: WebsiteChartRenderer }
>();
export const rendererPreferenceVersion = (owner: string) =>
  values.get(owner)?.version ?? 0;
export function publishRenderer(
  renderer: WebsiteChartRenderer | undefined,
  owner: string,
  readVersion?: number,
) {
  if (rendererAccountKey() !== owner) return;
  const previous = values.get(owner);
  if (
    readVersion !== undefined &&
    readVersion !== rendererPreferenceVersion(owner)
  )
    return previous?.renderer;
  const next = renderer === "kline" ? "kline" : "lightweight";
  values.set(owner, {
    version: readVersion ?? rendererPreferenceVersion(owner) + 1,
    renderer: next,
  });
  try {
    localStorage.setItem(rendererCacheKey(owner), next);
  } catch {
    /* Storage can be disabled. */
  }
  window.dispatchEvent(
    new CustomEvent("website-chart-settings", {
      detail: { owner, renderer: next },
    }),
  );
  return next;
}
