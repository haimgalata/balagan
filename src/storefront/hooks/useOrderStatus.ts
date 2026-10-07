import { useEffect, useState } from "react";
import { useBusinessSettings } from "@/storefront/context/BusinessSettingsContext";
import { computeScheduleStatus } from "@/storefront/lib/scheduleStatus";
import { getOrderingRules, type FulfillmentMethod } from "@/storefront/lib/fulfillment";

interface OrderStatus {
  /** Whether the site is accepting online orders RIGHT NOW: the schedule says open AND the manual pause is off. */
  isOpen: boolean;
  /** Today's configured order hours, regardless of the manual pause (so a paused banner still shows when it'll reopen). */
  hoursLabel: string;
  /** Pickup from the store or delivery (see fulfillment.ts). */
  fulfillment: FulfillmentMethod;
  /** 0 for pickup. */
  minOrderCents: number;
  /** 0 for pickup. */
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

  const rules = getOrderingRules(settings);
  return {
    isOpen: schedule.isOpen && !settings.orders_paused,
    hoursLabel: schedule.hoursLabel,
    fulfillment: rules.fulfillment,
    minOrderCents: rules.minOrderCents,
    deliveryFeeCents: rules.deliveryFeeCents,
  };
}
