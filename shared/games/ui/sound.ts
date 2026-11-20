/** Short tones for the countdown and the result (off by default, spec 17.3). One lazy AudioContext; every failure is swallowed. */
let context: AudioContext | null = null

export type Tone = 'tick' | 'go' | 'good' | 'low'
const FREQUENCY: Record<Tone, number> = { tick: 440, go: 880, good: 660, low: 220 }

export function playTone(tone: Tone): void {
  try {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    context ??= new Ctor()
    if (context.state === 'suspended') void context.resume()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = FREQUENCY[tone]
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (tone === 'go' ? 0.28 : 0.14))
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.3)
  } catch { /* no audio device or blocked: silence is fine */ }
}
