import { useEffect, useState } from "react";
import { useBusinessSettings } from "@/context/BusinessSettingsContext";
import { computeScheduleStatus } from "@/lib/scheduleStatus";

interface OrderStatus {
  /** Whether the site is accepting online orders RIGHT NOW: the schedule says open AND the manual pause is off. */
  isOpen: boolean;
  /** Today's configured order hours, regardless of the manual pause (so a paused banner still shows when it'll reopen). */
  hoursLabel: string;
  minOrderCents: number;
  deliveryFeeCents: number;
}

/**
 * Whether the site is taking ONLINE ORDERS right now — a separate concept from the physical store's own
 * hours (see `useStoreStatus`). The manual `orders_paused` override is a one-way switch: it can only force
 * orders closed early: `isOpen = schedule says open AND NOT orders_paused` — it can never force orders open
 * outside the configured schedule (see supabase/migrations/0008_business_settings.sql).
 */
export function useOrderStatus(): OrderStatus {
  const { settings } = useBusinessSettings();
  const [schedule, setSchedule] = useState(() => computeScheduleStatus(settings.order_hours));

  useEffect(() => {
    setSchedule(computeScheduleStatus(settings.order_hours));
    const interval = setInterval(() => setSchedule(computeScheduleStatus(settings.order_hours)), 60_000);
    return () => clearInterval(interval);
  }, [settings.order_hours]);

  return {
    isOpen: schedule.isOpen && !settings.orders_paused,
    hoursLabel: schedule.hoursLabel,
    minOrderCents: settings.min_order_cents,
    deliveryFeeCents: settings.delivery_fee_cents,
  };
}
