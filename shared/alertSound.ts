/** Small synthesized alert beep (no audio asset). Browsers need a user gesture first. */
let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context) return context;
  const Ctor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/** Call from a click/key handler (Start, Resume, Test sound) so later beeps are allowed. */
export function unlockAlertAudio(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

/** Two rounds of two tones (about 1.2 s in all), so the alert is long enough to notice. Returns false if audio is unavailable. */
export function playAlertBeep(): boolean {
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const first = ctx.currentTime + 0.02;
  const ROUNDS = 2, ROUND_GAP = 0.7;
  for (let round = 0; round < ROUNDS; round += 1) {
    [880, 1175].forEach((frequency, index) => {
      const at = first + round * ROUND_GAP + index * 0.22;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.21);
    });
  }
  return true;
}
