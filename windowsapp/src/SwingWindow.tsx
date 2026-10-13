import KotakLoginDialog from "./KotakLoginDialog";
import type { AccountRequest } from "./DesktopSettingsModal";
import { bounded, SAVE_TIMEOUT_MS } from "./windowLifecycle";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { invoke } from "@tauri-apps/api/core";
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
  onPopOut,
  registerSave,
  onAnalyse,
  onCloseWindow,
  registerNavigationGuard,
  brokerRequest,
}: {
  request: SwingRequest;
  brokerRequest: AccountRequest;
  loadSymbols: () => Promise<SymbolChoice[]>;
  Renderer: ComponentType<SwingChartProps>;
  portfolioId?: string;
  workspaceId?: string;
  onDetach: () => void;
  onCreateLinked?: (id: string) => void;
  onPopOut?: (id: string) => void;
  registerSave: (id: string, save: (() => Promise<unknown>) | null) => void;
  onAnalyse?: (id: string, sid?: string) => void;
  onCloseWindow: () => Promise<void>;
  registerNavigationGuard: (id: string, guard: (() => boolean) | null) => void;
}) {
  const [error, setError] = useState("");
  const [kotakLogin, setKotakLogin] = useState(false),
    [brokerRevision, setBrokerRevision] = useState(0);
  const labels = useRef({ dirty: false, saving: false });
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
    registerNavigationGuard(
      key,
      () =>
        !labels.current.saving &&
        (!labels.current.dirty ||
          window.confirm("Discard unsaved trade labels?")),
    );
    return () => registerNavigationGuard(key, null);
  }, [key, registerNavigationGuard]);
  useEffect(() => () => registerSave(key, null), [key, registerSave]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {kotakLogin && (
        <KotakLoginDialog
          request={brokerRequest}
          onCancel={() => setKotakLogin(false)}
          onConnected={() => {
            setKotakLogin(false);
            setBrokerRevision((n) => n + 1);
          }}
        />
      )}
      <SwingPortfolioPanel
        request={request}
        brokerRevision={brokerRevision}
        onConnectBroker={(broker) => {
          if (broker === "kotak") setKotakLogin(true);
        }}
        loadSymbols={loadSymbols}
        renderChart={Renderer}
        surface="desktop"
        portfolioId={portfolioId}
        workspaceId={workspaceId}
        companion={Boolean(workspaceId)}
        onPortfolioReady={onReady}
        onSaveReady={onSaveReady}
        onCreateLinked={native ? onCreateLinked : undefined}
        onPopOut={native ? onPopOut : undefined}
        onAnalyse={onAnalyse}
        onDraftStateChange={(state) => {
          labels.current = state;
        }}
        onDetach={() => {
          if (workspaceId && native) {
            void onCloseWindow();
            return;
          }
          void bounded(Promise.resolve(save.current?.()), SAVE_TIMEOUT_MS)
            .then(onDetach)
            .catch((cause) =>
              setError(`Settings could not be saved: ${String(cause)}`),
            );
        }}
      />
    </>
  );
}
