import type { AdminRole } from "@/admin/useAdminSession";
import { OrderActionBar } from "@/admin/orders/OrderActionBar";
import { StatusBadge } from "@/admin/orders/OrderDetailContent";
import type { OrderActions } from "@/admin/orders/useOrderActions";
import {
  FORGOTTEN_ORDER_MS,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  STALE_NEW_ORDER_MS,
  STOCK_RETURN_LABEL,
  addressLine,
  formatAge,
  formatShekel,
  fullName,
  type OrderRow,
} from "@/admin/orders/orderModel";

interface OrderCardProps {
  order: OrderRow;
  role: AdminRole;
  actions: OrderActions;
  now: number;
  onOpen: (order: OrderRow) => void;
}

const MAX_ITEM_LINES = 4;

/** One order on the board: what to fetch, where to take it, how much to collect, and the next step. */
export function OrderCard({ order, role, actions, now, onOpen }: OrderCardProps) {
  const items = order.order_items ?? [];
  const waitedMs = now - new Date(order.status_changed_at).getTime();
  const isNew = order.order_status === "confirmed";
  const late = isNew && waitedMs > STALE_NEW_ORDER_MS;
  const forgotten = now - new Date(order.created_at).getTime() > FORGOTTEN_ORDER_MS;
  const unitsTotal = items.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <article
      data-testid="order-card"
      data-order-number={order.order_number}
      data-status={order.order_status}
      className={`rounded-xl border bg-brand-bg-elevated p-3 ${late || forgotten ? "border-brand-danger" : isNew ? "border-brand-gold" : "border-brand-border"}`}
    >
      <button type="button" onClick={() => onOpen(order)} className="block w-full text-start outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold" aria-label={`פתיחת הזמנה ${order.order_number}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg font-bold text-brand-text">#{order.order_number}</span>
          <span className={`text-sm ${late || forgotten ? "font-semibold text-brand-danger" : "text-brand-text-muted"}`}>
            {forgotten ? "⚠ " : ""}
            {formatAge(order.created_at, now)}
          </span>
        </div>
        <div className="mt-1 text-base font-medium text-brand-text">{fullName(order)}</div>
        <div className="text-sm text-brand-text-muted">{addressLine(order)}</div>
        <div className="text-sm text-brand-text-muted" dir="ltr" style={{ textAlign: "start" }}>
          {order.phone}
        </div>

        <ul className="mt-2 space-y-0.5 text-sm text-brand-text">
          {items.slice(0, MAX_ITEM_LINES).map((item) => (
            <li key={item.id} className="truncate">
              {item.quantity} × {item.product_name_snapshot}
              <span className="text-brand-text-muted"> · {item.option_label_snapshot}</span>
            </li>
          ))}
          {items.length > MAX_ITEM_LINES && <li className="text-brand-text-muted">ועוד {items.length - MAX_ITEM_LINES} פריטים…</li>}
        </ul>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-bold text-brand-gold">{formatShekel(order.total_cents)}</span>
          <span className="text-brand-text-muted">
            {PAYMENT_METHOD_LABEL[order.payment_method]}
            {order.payment_method === "cash" ? " — לגבות במסירה" : ` · ${PAYMENT_STATUS_LABEL[order.payment_status]}`}
            {unitsTotal > 0 ? ` · ${unitsTotal} פריטים` : ""}
          </span>
        </div>
        {order.delivery_notes && <div className="mt-1 rounded bg-brand-bg px-2 py-1 text-xs text-brand-text-muted">הערה: {order.delivery_notes}</div>}
        {order.order_status === "cancelled" && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-brand-danger">
            <StatusBadge status={order.order_status} />
            <span>{order.cancel_reason}</span>
            <span className="text-brand-text-muted">{STOCK_RETURN_LABEL[order.stock_return_status]}</span>
          </div>
        )}
      </button>

      <div className="mt-3">
        <OrderActionBar order={order} role={role} actions={actions} size="lg" />
      </div>
    </article>
  );
}
