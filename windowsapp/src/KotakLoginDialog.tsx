import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AccountRequest } from "./DesktopSettingsModal";

export default function KotakLoginDialog({
  request,
  onConnected,
  onCancel,
}: {
  request: AccountRequest;
  onConnected: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const alive = useRef(false);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    form.current?.querySelector("input")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!pending.current) cancel.current();
      } else if (event.key === "Tab") {
        const items = Array.from(
          form.current?.querySelectorAll<HTMLElement>(
            "input:not(:disabled),button:not(:disabled)",
          ) ?? [],
        );
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) {
          event.preventDefault();
          return;
        }
        if (
          (event.shiftKey && index <= 0) ||
          (!event.shiftKey && (index < 0 || index === items.length - 1))
        ) {
          event.preventDefault();
          items[event.shiftKey ? items.length - 1 : 0].focus();
        }
      }
    };
    window.addEventListener("keydown", keys, true);
    return () => {
      alive.current = false;
      window.removeEventListener("keydown", keys, true);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!busy) form.current?.querySelector("input")?.focus();
  }, [busy]);
  const submit = async () => {
    if (pending.current || !/^\d{6}$/.test(code)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await request("kotak/login", "POST", { totp: code });
      if (alive.current) {
        setCode("");
        onConnected();
      }
    } catch (cause) {
      if (alive.current) {
        setCode("");
        setError(String(cause));
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };
  return createPortal(
    <div className="modal-backdrop kotak-login-backdrop">
      <form
        ref={form}
        className="kotak-login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kotak-login-title"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      >
        <header>
          <strong id="kotak-login-title">Kotak Neo login</strong>
          <button
            type="button"
            aria-label="Close Kotak login"
            disabled={busy}
            onClick={onCancel}
          >
            ×
          </button>
        </header>
        <p>
          Enter the 6-digit TOTP from your authenticator app to connect Kotak
          Neo.
        </p>
        <label>
          Authentication code
          <input
            aria-label="Kotak authentication code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            disabled={busy}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Connecting…" : "Connect Kotak Neo"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
