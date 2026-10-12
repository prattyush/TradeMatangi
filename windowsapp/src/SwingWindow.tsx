import { bounded, closeAfterSave, SAVE_TIMEOUT_MS } from "./windowLifecycle";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import SwingPortfolioPanel, {
  type SwingRequest,
} from "../../shared/SwingPortfolioPanel";
import type { SwingChartProps } from "../../shared/SwingWorkspace";
import type { SymbolChoice } from "../../shared/SymbolSearch";

export default function SwingWindow({
  request,
  loadSymbols,
  Renderer,
  portfolioId,
  workspaceId,
  onDetach,
  onCreateLinked,
  registerSave,
  onAnalyse,
}: {
  request: SwingRequest;
  loadSymbols: () => Promise<SymbolChoice[]>;
  Renderer: ComponentType<SwingChartProps>;
  portfolioId?: string;
  workspaceId?: string;
  onDetach: () => void;
  onCreateLinked?: (id: string) => void;
  registerSave: (id: string, save: (() => Promise<unknown>) | null) => void;
  onAnalyse?: (id: string, sid?: string) => void;
}) {
  const [error, setError] = useState(""),
    [closing, setClosing] = useState(false);
  const save = useRef<(() => Promise<unknown>) | null>(null),
    acknowledged = useRef(false);
  const native = "__TAURI_INTERNALS__" in window;
  const key = workspaceId ?? "swing-primary";
  const onSaveReady = useCallback(
    (value: (() => Promise<unknown>) | null) => {
      save.current = value;
      registerSave(key, value);
    },
    [key, registerSave],
  );
  const onReady = useCallback(() => {
    if (!workspaceId || acknowledged.current || !native) return;
    const token = new URLSearchParams(location.search).get("handoff_token");
    if (!token) {
      setError("Window handoff is missing. Reopen from the main window.");
      return;
    }
    acknowledged.current = true;
    void invoke("ready_screen_window", {
      screenId: workspaceId,
      handoffToken: token,
    }).catch((cause) => {
      acknowledged.current = false;
      setError(String(cause));
    });
  }, [workspaceId, native]);
  useEffect(() => {
    if (!workspaceId || !native) return;
    const listener = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      await closeAfterSave(
        Promise.resolve(save.current?.()),
        async () => {
          setClosing(true);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          await invoke("finish_window_close");
        },
        (cause) => setError(`Settings could not be saved: ${String(cause)}`),
      );
    });
    return () => {
      void listener.then((stop) => stop());
    };
  }, [workspaceId, native]);
  useEffect(() => () => registerSave(key, null), [key, registerSave]);
  if (closing) return null;
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <SwingPortfolioPanel
        request={request}
        loadSymbols={loadSymbols}
        renderChart={Renderer}
        surface="desktop"
        portfolioId={portfolioId}
        workspaceId={workspaceId}
        companion={Boolean(workspaceId)}
        onPortfolioReady={onReady}
        onSaveReady={onSaveReady}
        onCreateLinked={native ? onCreateLinked : undefined}
        onAnalyse={onAnalyse}
        onDetach={() => {
          void bounded(Promise.resolve(save.current?.()), SAVE_TIMEOUT_MS)
            .then(() => {
              if (workspaceId && native) {
                setClosing(true);
                requestAnimationFrame(() => void invoke("finish_window_close"));
              } else onDetach();
            })
            .catch((cause) =>
              setError(`Settings could not be saved: ${String(cause)}`),
            );
        }}
      />
    </>
  );
}
