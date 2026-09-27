/**
 * Turns a weekly schedule (7 rows, one per day) into "is it open right now" + a human hours label. Shared by
 * `useStoreStatus`/`useOrderStatus` (physical store vs. online orders) and `StoreHoursPanel`.
 *
 * Anchored explicitly to Asia/Jerusalem — the OLD `useBusinessStatus` trusted the visitor's own device clock
 * and timezone, which is wrong for anyone abroad (or with their clock set incorrectly); the store itself has
 * exactly one timezone, so "now" here always means "now in Israel", regardless of who's looking.
 */
import type { RpcHour } from "@/storefront/lib/businessSettingsApi";

export interface ScheduleStatus {
  isOpen: boolean;
  hoursLabel: string;
}

/** Current day-of-week (0 = Sunday) and minutes-since-midnight, in Asia/Jerusalem. */
export function getIsraelNow(): { dayOfWeek: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  return { dayOfWeek: dayOfWeek === -1 ? 0 : dayOfWeek, minutes: (hour % 24) * 60 + minute };
}

const toMinutes = (time: string): number => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/** "HH:MM:SS" (as Postgres `time` round-trips) or "HH:MM" -> "HH:MM". */
export const shortTime = (time: string): string => time.slice(0, 5);

export function computeScheduleStatus(week: RpcHour[]): ScheduleStatus {
  const { dayOfWeek, minutes } = getIsraelNow();
  const today = week.find((d) => d.day_of_week === dayOfWeek) ?? null;
  if (!today || !today.is_open || !today.open_time || !today.close_time) {
    return { isOpen: false, hoursLabel: "סגור היום" };
  }
  const isOpen = minutes >= toMinutes(today.open_time) && minutes < toMinutes(today.close_time);
  return { isOpen, hoursLabel: `${shortTime(today.open_time)}–${shortTime(today.close_time)}` };
}
