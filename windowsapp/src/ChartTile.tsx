import { invoke } from "@tauri-apps/api/core";
import type { ComponentProps } from "react";
import { KLineChart } from "../../shared/charts/KLineChart";
import { announceDrawingChange, watchDrawingChanges } from "./drawingChanges";
const drawingEvents = {
  announce: announceDrawingChange,
  watch: watchDrawingChanges,
};
const diagnostic = (kind: string, payload: Record<string, unknown>) => {
  if ("__TAURI_INTERNALS__" in window)
    void invoke("record_desktop_renderer_diagnostic", { kind, payload }).catch(
      () => undefined,
    );
};
export function ChartTile(props: ComponentProps<typeof KLineChart>) {
  return (
    <KLineChart
      {...props}
      drawingEvents={drawingEvents}
      reportChartDiagnostic={diagnostic}
    />
  );
}
