import { useEffect, useState } from "react";

/**
 * Generic localStorage-backed state hook.
 * Used by the cart and the age gate so persistence logic lives in one place.
 *
 * `sanitize`, when given, runs on whatever was parsed from storage before
 * it becomes state — use it to migrate an older stored shape or drop
 * invalid/stale entries instead of trusting storage blindly.
 */
export function useLocalStorage<T>(key: string, initialValue: T, sanitize?: (value: T) => T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === null) return initialValue;
      const parsed = JSON.parse(stored) as T;
      return sanitize ? sanitize(parsed) : parsed;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // localStorage unavailable (private mode, quota, etc.) — fail silently
    }
  }, [key, value]);

  return [value, setValue] as const;
}
