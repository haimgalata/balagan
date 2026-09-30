import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBoard, type BoardData } from "@/admin/orders/ordersApi";
import type { OrderError } from "@/admin/orders/ordersErrors";
import { israelStartOfDay } from "@/admin/orders/orderModel";
import { useNow } from "@/admin/orders/useNow";

/** Safety net under Realtime: even if every push event is lost, the board is at most this stale. */
export const POLL_MS = 30_000;
/** No successful load for this long => the screen says it is OFFLINE (silence must never look like "no orders"). */
export const OFFLINE_AFTER_MS = 90_000;
const EVENT_DEBOUNCE_MS = 250;

export type Connection = "connecting" | "live" | "reconnecting" | "offline";

/**
 * The Active board's data. CORRECTNESS comes from a plain query of the open orders, re-run on a timer, on every
 * Realtime (re)subscribe, on tab-visible and on network-back; Supabase Realtime only makes it FAST — a
 * postgres_changes event just means "reload now" and its payload is ignored (delivery is at-most-once with no
 * replay, so a missed event costs at most POLL_MS, never an order).
 */
export function useActiveOrders(client: SupabaseClient) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<OrderError | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [realtime, setRealtime] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const seq = useRef(0);
  const now = useNow(15_000);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const result = await loadBoard(client, israelStartOfDay());
    if (mine !== seq.current) return; // a newer load is already in flight / landed
    if (result.ok) {
      setData(result.data);
      setError(null);
      setLastSyncAt(Date.now());
    } else {
      setError(result.error);
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

    let debounce: number | undefined;
    const channel = client
      .channel("orders-board")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtime("live");
          void refresh(); // anything that happened while we were (re)connecting
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setRealtime("reconnecting");
        }
      });

    return () => {
      window.clearInterval(poll);
      window.clearTimeout(debounce);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      void client.removeChannel(channel);
    };
  }, [client, refresh]);

  const connection: Connection =
    lastSyncAt === null ? (error ? "offline" : "connecting") : now - lastSyncAt > OFFLINE_AFTER_MS ? "offline" : realtime;

  return { data, error, connection, lastSyncAt, refresh };
}
