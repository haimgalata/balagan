/** Sounds for the order terminal, generated with Web Audio (no audio files to ship or fail to load). */

type AudioCtor = typeof AudioContext;
const getCtor = (): AudioCtor | null =>
  typeof window === "undefined" ? null : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext ?? null);

/** Must be called from a user gesture (a click) — browsers refuse audio before one. */
export function createAudioContext(): AudioContext | null {
  const Ctor = getCtor();
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number, volume = 0.35) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/** Three rising notes: a new order is waiting. */
export function playNewOrderChime(ctx: AudioContext): void {
  void ctx.resume();
  const t = ctx.currentTime;
  tone(ctx, 880, t, 0.5);
  tone(ctx, 1175, t + 0.28, 0.6);
  tone(ctx, 1480, t + 0.56, 0.7);
}

/** Two low falling notes: something was cancelled / needs attention. Deliberately unlike the new-order chime. */
export function playWarningTone(ctx: AudioContext): void {
  void ctx.resume();
  const t = ctx.currentTime;
  tone(ctx, 440, t, 0.45, 0.4);
  tone(ctx, 330, t + 0.3, 0.6, 0.4);
}
