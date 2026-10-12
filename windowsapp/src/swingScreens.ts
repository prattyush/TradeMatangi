/** Swing screen records are UI companions, never intraday execution screens. */
export interface SwingScreenRecord {
  saved?: { workspace_kind?: string; portfolio_id?: string };
}
export const isSwingScreen = (screen: SwingScreenRecord) =>
  screen.saved?.workspace_kind === "swing";
export function updateDayScreens<T extends SwingScreenRecord>(
  screens: T[],
  update: T[] | ((day: T[]) => T[]),
): T[] {
  const day = screens.filter((screen) => !isSwingScreen(screen));
  return [
    ...(typeof update === "function" ? update(day) : update),
    ...screens.filter(isSwingScreen),
  ];
}
export function pinnedSwingPortfolio(screen: SwingScreenRecord): string | null {
  return isSwingScreen(screen) && screen.saved?.portfolio_id?.trim()
    ? screen.saved.portfolio_id
    : null;
}
