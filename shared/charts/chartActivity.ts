import { useSyncExternalStore } from "react";
let count = 0;
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((fn) => fn());
}
export function beginChartActivity() {
  count++;
  notify();
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      count--;
      notify();
    }
  };
}
export function useChartActivity() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => count > 0,
  );
}
