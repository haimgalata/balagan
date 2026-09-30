import { useCallback, useEffect, useRef, useState } from "react";
import { createAudioContext, playNewOrderChime, playWarningTone } from "@/admin/orders/orderSound";

export const REPEAT_CHIME_MS = 30_000;
const MUTED_KEY = "balagan_orders_muted";
const ANNOUNCED_KEY = "balagan_orders_announced";
const BASE_TITLE_FALLBACK = "ניהול · בלאגן";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — alerts still work, they just may repeat once after a reload
  }
}

/**
 * Sound + attention for orders waiting in "new" (`confirmed`).
 *
 * The alert is derived from STATE, not from events: it rings for any waiting order this device has not yet
 * announced, then repeats every REPEAT_CHIME_MS until nobody is waiting (someone moved them to "preparing").
 * So a missed Realtime event, a duplicate event, a page reload and two terminals open at once are all harmless.
 * The announced set lives in localStorage so a reload doesn't re-ring for orders that already rang.
 */
export function useOrderAlerts(newOrderIds: string[]) {
  const ctxRef = useRef<AudioContext | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [muted, setMuted] = useState(() => readJson<boolean>(MUTED_KEY, false));
  const [wakeLockHeld, setWakeLockHeld] = useState(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const shiftActive = useRef(false);
  const baseTitle = useRef(typeof document === "undefined" ? BASE_TITLE_FALLBACK : document.title);

  const acquireWakeLock = useCallback(async () => {
    try {
      if (!("wakeLock" in navigator)) return;
      const sentinel = await navigator.wakeLock.request("screen");
      wakeLock.current = sentinel;
      setWakeLockHeld(true);
      sentinel.addEventListener("release", () => setWakeLockHeld(false));
    } catch {
      setWakeLockHeld(false); // denied (low battery, unsupported context) — the screen may sleep; not fatal
    }
  }, []);

  /** "Start shift": the one user gesture that unlocks audio, plus keeps the screen awake. */
  const startShift = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = createAudioContext();
    if (ctxRef.current) {
      void ctxRef.current.resume();
      setSoundOn(true);
    }
    shiftActive.current = true;
    void acquireWakeLock();
  }, [acquireWakeLock]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      writeJson(MUTED_KEY, !current);
      return !current;
    });
  }, []);

  const playWarning = useCallback(() => {
    if (ctxRef.current && soundOn && !muted) playWarningTone(ctxRef.current);
  }, [soundOn, muted]);

  // The screen lock is released when the tab is hidden — take it again when the tab is back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && shiftActive.current) void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void wakeLock.current?.release().catch(() => undefined);
      void ctxRef.current?.close().catch(() => undefined);
    };
  }, [acquireWakeLock]);

  // Announce anything not yet announced (once), then forget ids that are no longer waiting.
  const idsKey = newOrderIds.join(",");
  useEffect(() => {
    if (!soundOn) return;
    const announced = new Set(readJson<string[]>(ANNOUNCED_KEY, []));
    const fresh = newOrderIds.filter((id) => !announced.has(id));
    if (fresh.length > 0 && !muted && ctxRef.current) playNewOrderChime(ctxRef.current);
    writeJson(ANNOUNCED_KEY, newOrderIds); // (also prunes ids that moved on)
    // idsKey is the stable form of newOrderIds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, soundOn, muted]);

  // Keep ringing while anyone is still waiting.
  const waiting = newOrderIds.length;
  useEffect(() => {
    if (!soundOn || muted || waiting === 0) return;
    const timer = window.setInterval(() => {
      if (ctxRef.current) playNewOrderChime(ctxRef.current);
    }, REPEAT_CHIME_MS);
    return () => window.clearInterval(timer);
  }, [soundOn, muted, waiting]);

  // Tab title: flashes "(N) new order" so a tablet across the room / another tab still shows it.
  useEffect(() => {
    if (waiting === 0) {
      document.title = baseTitle.current;
      return;
    }
    let flip = false;
    const apply = () => {
      document.title = flip ? baseTitle.current : `(${waiting}) 🔔 הזמנה חדשה`;
      flip = !flip;
    };
    apply();
    const timer = window.setInterval(apply, 1200);
    return () => {
      window.clearInterval(timer);
      document.title = baseTitle.current;
    };
  }, [waiting]);

  return { soundOn, muted, wakeLockHeld, startShift, toggleMute, playWarning };
}
