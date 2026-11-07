import { useEffect, useRef } from "react";
import { playAlertBeep, unlockAlertAudio } from "./alertSound";
import { createCandleAlertTracker, type CandleAlertConfig } from "./candleAlert";

export type CandleAlertClock =
  /** Replay: session market clock (IST-as-UTC seconds); pauses with the session. */
  | { kind: "market"; time: number | null | undefined }
  /** Paper/Real: live wall clock (epoch alignment matches IST for 1-30 min intervals). */
  | { kind: "wall" }
  | { kind: "off" };

/**
 * Plays the alert beep `secondsBefore` seconds before each `intervalMin`
 * candle closes. Mount once per app. `sessionKey` resets history when the
 * session changes so a new session never fires from a stale sample.
 */
export function useCandleAlert(
  clock: CandleAlertClock,
  config: CandleAlertConfig,
  sessionKey: string | null,
  onSound: () => void = () => void playAlertBeep(),
): void {
  const tracker = useRef(createCandleAlertTracker());
  const soundRef = useRef(onSound);
  soundRef.current = onSound;
  const configRef = useRef(config);
  configRef.current = config;
  const marketTime = clock.kind === "market" ? clock.time : null;
  const kind = clock.kind;

  useEffect(() => {
    tracker.current.reset();
  }, [sessionKey, kind, config.enabled, config.intervalMin, config.secondsBefore]);

  // Browsers only allow audio after a user gesture; Start/Resume clicks count.
  useEffect(() => {
    if (!config.enabled) return;
    const unlock = () => unlockAlertAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [config.enabled]);

  useEffect(() => {
    if (kind !== "market") return;
    if (tracker.current.observe(marketTime, configRef.current)) soundRef.current();
  }, [kind, marketTime]);

  useEffect(() => {
    if (kind !== "wall" || !config.enabled) return;
    const timer = window.setInterval(() => {
      if (tracker.current.observe(Date.now() / 1000, configRef.current)) soundRef.current();
    }, 500);
    return () => window.clearInterval(timer);
  }, [kind, config.enabled]);
}
