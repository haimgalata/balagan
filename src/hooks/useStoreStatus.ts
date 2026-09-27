import { useEffect, useState } from "react";
import { useBusinessSettings } from "@/context/BusinessSettingsContext";
import { computeScheduleStatus, type ScheduleStatus } from "@/lib/scheduleStatus";

/**
 * The PHYSICAL store's live open/closed status + today's hours, derived from the store schedule in
 * BusinessSettingsContext. Recomputed every minute so it stays accurate across a long-lived tab. This is
 * about the shop itself — see `useOrderStatus` for whether the site is taking online orders, a separate
 * concept (CLAUDE.md).
 */
export function useStoreStatus(): ScheduleStatus {
  const { settings } = useBusinessSettings();
  const [status, setStatus] = useState<ScheduleStatus>(() => computeScheduleStatus(settings.store_hours));

  useEffect(() => {
    setStatus(computeScheduleStatus(settings.store_hours));
    const interval = setInterval(() => setStatus(computeScheduleStatus(settings.store_hours)), 60_000);
    return () => clearInterval(interval);
  }, [settings.store_hours]);

  return status;
}
