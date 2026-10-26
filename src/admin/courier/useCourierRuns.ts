import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMyRuns, loadOpenRuns } from "@/admin/courier/courierApi";
import type { MyRun, OpenRun } from "@/admin/courier/courierModel";
import type { OrderError } from "@/admin/orders/ordersErrors";

const POLL_MS = 30_000;

export interface CourierData {
  open: OpenRun[];
  mine: MyRun[];
}

/**
 * The courier's two lists, re-read on a timer, whenever the tab comes back and when the network returns (no Realtime:
 * a courier has no table access to subscribe to, and 30 seconds is plenty for a run that leaves once). A failed
 * refresh keeps the last good lists on screen and shows the error.
 */
export function useCourierRuns(client: SupabaseClient) {
  const [data, setData] = useState<CourierData | null>(null);
  const [error, setError] = useState<OrderError | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const [open, own] = await Promise.all([loadOpenRuns(client), loadMyRuns(client)]);
    if (mine !== seq.current) return;
    if (open.ok && own.ok) {
      setData({ open: open.data, mine: own.data });
      setError(null);
    } else {
      setError((!open.ok ? open.error : !own.ok ? own.error : null) ?? null);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  return { data, error, refresh };
}
