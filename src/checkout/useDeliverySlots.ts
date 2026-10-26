import { useCallback, useEffect, useState } from "react";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { fetchDeliverySlots } from "@/checkout/lib/deliverySlotsApi";
import type { DeliverySlot } from "@/storefront/lib/deliveryWindows";

export type DeliverySlotsState =
  | { status: "idle" } // not a delivery order, or not a live database: no window is involved
  | { status: "loading" }
  | { status: "ready"; slots: DeliverySlot[] }
  | { status: "failed" };

/**
 * Loads today's windows for a delivery checkout. `knownWindows` is what the (cached) public settings already say
 * exists: if the call fails while windows are known to exist, the state is "failed" (checkout cannot proceed on a guess);
 * if none are known to exist a failure just means "no windows" and the order goes through without one, as before 0017.
 */
export function useDeliverySlots(enabled: boolean, knownWindows: boolean): DeliverySlotsState & { refresh: () => void } {
  const [state, setState] = useState<DeliverySlotsState>({ status: enabled ? "loading" : "idle" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const config = getCatalogConfig();
    if (!enabled || config.source !== "supabase") {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    fetchDeliverySlots(config)
      .then((slots) => !cancelled && setState({ status: "ready", slots }))
      .catch(() => !cancelled && setState(knownWindows ? { status: "failed" } : { status: "ready", slots: [] }));
    return () => {
      cancelled = true;
    };
  }, [enabled, knownWindows, tick]);

  // The windows change with the clock (cut-off passes, a window fills): look again when the tab comes back.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, refresh]);

  return { ...state, refresh };
}
