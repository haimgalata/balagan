import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import type { AdminRole } from "@/admin/useAdminSession";
import { CancelOrderDialog } from "@/admin/orders/CancelOrderDialog";
import type { OrderActions } from "@/admin/orders/useOrderActions";
import { advanceAction, backAction, canCancel, needsStockReturn, type OrderRow } from "@/admin/orders/orderModel";

interface OrderActionBarProps {
  order: OrderRow;
  role: AdminRole;
  actions: OrderActions;
  /** "large" for board cards (tablet-friendly touch targets). */
  size?: "md" | "lg";
  /** called after a successful move to `completed` so the board can offer "undo" */
  onMoved?: (order: OrderRow, to: string) => void;
}

/**
 * The buttons for one order, identical on a board card and in the detail panel: the main step forward, a step
 * back, cancel (with mandatory reason), and — for an order cancelled after leaving — confirming the goods
 * came back. What shows is only what the role may do; the database re-checks every one of them.
 */
export function OrderActionBar({ order, role, actions, size = "md", onMoved }: OrderActionBarProps) {
  const [cancelling, setCancelling] = useState(false);
  const [confirmWriteOff, setConfirmWriteOff] = useState(false);
  // Staff cannot reopen a completed order (owner-only), so "delivered" needs a deliberate second tap.
  const [armedComplete, setArmedComplete] = useState(false);
  useEffect(() => {
    if (!armedComplete) return;
    const timer = window.setTimeout(() => setArmedComplete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armedComplete]);
  const busy = actions.busyId === order.id;
  const advance = advanceAction(order.order_status);
  const back = backAction(order.order_status, role);

  const run = async (to: Parameters<typeof actions.move>[1], reason?: string) => {
    const ok = await actions.move(order, to, reason);
    if (ok) onMoved?.(order, to);
    return ok;
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {advance && (
        <Button size={size} className={size === "lg" ? "flex-1 !py-3.5 text-base" : ""} disabled={busy} onClick={() => {
            if (advance.to === "completed" && !armedComplete) setArmedComplete(true);
            else {
              setArmedComplete(false);
              void run(advance.to);
            }
          }}
        >
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          {advance.to === "completed" && armedComplete ? "לחצו שוב לאישור מסירה" : advance.label}
        </Button>
      )}
      {back && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(back.to)}>
          {back.label}
        </Button>
      )}
      {canCancel(order.order_status) && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(true)} className="text-brand-danger">
          ביטול
        </Button>
      )}
      {needsStockReturn(order) && (
        <>
          <Button size={size} disabled={busy} onClick={() => void actions.settleStock(order, "returned")}>
            המוצרים חזרו למלאי
          </Button>
          {role === "owner" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className="text-brand-danger"
              onClick={() => {
                if (confirmWriteOff) void actions.settleStock(order, "written_off");
                else setConfirmWriteOff(true);
              }}
            >
              {confirmWriteOff ? "בטוחים? המלאי לא יוחזר" : "לא חזרו"}
            </Button>
          )}
        </>
      )}

      {cancelling && (
        <CancelOrderDialog
          order={order}
          busy={busy}
          error={actions.error?.message ?? null}
          onClose={() => setCancelling(false)}
          onConfirm={(reason) => {
            void run("cancelled", reason).then((ok) => {
              if (ok) setCancelling(false);
            });
          }}
        />
      )}
    </div>
  );
}
