interface Change {
  owner: string;
  keys: string[];
}
const eventName = "desktop-drawings-changed";
export function announceDrawingChange(change: Change) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: change }));
}
export function watchDrawingChanges(
  owner: string,
  keys: string[],
  refresh: () => void,
) {
  const listener = (event: Event) => {
    const change = (event as CustomEvent<Change>).detail;
    if (
      change?.owner !== owner &&
      change?.keys?.some((key) => keys.includes(key))
    )
      refresh();
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
