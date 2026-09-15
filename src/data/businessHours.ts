/**
 * Store opening hours, keyed by JS `Date#getDay()` (0 = Sunday ... 6 = Saturday).
 * `null` means closed that day.
 *
 * Placeholder values — edit to match the real schedule. Consumed by
 * `useBusinessStatus` to derive the live open/closed indicator and the
 * hours line in `BusinessInfoBar`.
 */
export interface DayHours {
  open: string; // "HH:MM", 24h
  close: string; // "HH:MM", 24h
}

export const businessHours: Record<number, DayHours | null> = {
  0: { open: "09:00", close: "23:00" }, // ראשון
  1: { open: "09:00", close: "23:00" }, // שני
  2: { open: "09:00", close: "23:00" }, // שלישי
  3: { open: "09:00", close: "23:00" }, // רביעי
  4: { open: "09:00", close: "23:00" }, // חמישי
  5: { open: "09:00", close: "16:00" }, // שישי
  6: null, // שבת - סגור
};

export const dayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
