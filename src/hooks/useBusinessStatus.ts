import { useEffect, useState } from "react";
import { businessHours, dayNames, type DayHours } from "@/data/businessHours";

interface BusinessStatus {
  isOpen: boolean;
  today: DayHours | null;
  todayLabel: string;
  hoursLabel: string;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function computeStatus(now: Date): BusinessStatus {
  const day = now.getDay();
  const today = businessHours[day] ?? null;
  const todayLabel = dayNames[day];

  let isOpen = false;
  if (today) {
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    isOpen = minutesNow >= toMinutes(today.open) && minutesNow < toMinutes(today.close);
  }

  const hoursLabel = today ? `${today.open}–${today.close}` : "סגור היום";

  return { isOpen, today, todayLabel, hoursLabel };
}

/**
 * Live open/closed status derived from `src/data/businessHours.ts`.
 * Recomputed every minute so it stays accurate across a long-lived tab.
 */
export function useBusinessStatus(): BusinessStatus {
  const [status, setStatus] = useState(() => computeStatus(new Date()));

  useEffect(() => {
    const interval = setInterval(() => setStatus(computeStatus(new Date())), 60_000);
    return () => clearInterval(interval);
  }, []);

  return status;
}
