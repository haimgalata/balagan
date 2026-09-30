import { useCallback, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveStockReturn, transitionOrder } from "@/admin/orders/ordersApi";
import type { OrderError } from "@/admin/orders/ordersErrors";
import type { OrderRow, OrderStatus } from "@/admin/orders/orderModel";

/**
 * Runs order actions (status moves, stock-return confirmation) and reloads afterwards. The database decides
 * whether each one is allowed; a STALE_STATUS answer simply means someone else got there first, so the
 * screen reloads to the truth and says so. `actedIds` records orders THIS terminal changed, so the board does
 * not raise a "cancelled by someone else" warning for the user's own cancellation.
 */
export function useOrderActions(client: SupabaseClient, refresh: () => Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<OrderError | null>(null);
  const actedIds = useRef(new Set<string>());

  const finish = useCallback(
    async (orderId: string, result: { ok: true } | { ok: false; error: OrderError }): Promise<boolean> => {
      if (!result.ok) setError(result.error);
      else setError(null);
      await refresh(); // success or stale/failed alike: the truth is whatever the database now says
      setBusyId((current) => (current === orderId ? null : current));
      return result.ok;
    },
    [refresh]
  );

  const move = useCallback(
    async (order: Pick<OrderRow, "id" | "order_status">, to: OrderStatus, reason?: string): Promise<boolean> => {
      setBusyId(order.id);
      actedIds.current.add(order.id);
      const result = await transitionOrder(client, order.id, order.order_status, to, reason);
      return finish(order.id, result);
    },
    [client, finish]
  );

  const settleStock = useCallback(
    async (order: Pick<OrderRow, "id">, outcome: "returned" | "written_off"): Promise<boolean> => {
      setBusyId(order.id);
      const result = await resolveStockReturn(client, order.id, outcome);
      return finish(order.id, result);
    },
    [client, finish]
  );

  return { busyId, error, clearError: () => setError(null), actedIds, move, settleStock };
}

export type OrderActions = ReturnType<typeof useOrderActions>;
