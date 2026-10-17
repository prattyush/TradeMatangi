import { emit, listen } from "@tauri-apps/api/event";

interface Change {
  owner: string;
  keys: string[];
}
const eventName = "desktop-drawings-changed";
export function announceDrawingChange(change: Change) {
  if ("__TAURI_INTERNALS__" in window)
    void emit(eventName, change).catch(() => undefined);
  else window.dispatchEvent(new CustomEvent(eventName, { detail: change }));
}
export function watchDrawingChanges(
  owner: string,
  keys: string[],
  refresh: () => void,
) {
  const apply = (change: Change) => {
    if (
      change?.owner !== owner &&
      change?.keys?.some((key) => keys.includes(key))
    )
      refresh();
  };
  const local = (event: Event) => apply((event as CustomEvent<Change>).detail);
  window.addEventListener(eventName, local);
  window.addEventListener("focus", refresh);
  let disposed = false;
  const native =
    "__TAURI_INTERNALS__" in window
      ? listen<Change>(eventName, (event) => apply(event.payload))
      : undefined;
  void native
    ?.then((stop) => {
      if (disposed) stop();
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    window.removeEventListener(eventName, local);
    window.removeEventListener("focus", refresh);
    void native?.then((stop) => stop()).catch(() => undefined);
  };
}
