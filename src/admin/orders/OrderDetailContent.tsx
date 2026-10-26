import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2, Phone } from "lucide-react";
import type { AdminRole } from "@/admin/useAdminSession";
import { loadOrderDetail } from "@/admin/orders/ordersApi";
import type { OrderError } from "@/admin/orders/ordersErrors";
import { OrderActionBar } from "@/admin/orders/OrderActionBar";
import type { OrderActions } from "@/admin/orders/useOrderActions";
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  STOCK_RETURN_LABEL,
  addressDetails,
  addressLine,
  departureLabel,
  isPickup,
  statusLabel,
  formatDateTime,
  formatShekel,
  fullName,
  paidButDead,
  type FulfillmentMethod,
  type OrderEventRow,
  type OrderRow,
  type OrderStatus,
  type PaymentStatus,
  type StockReturnStatus,
} from "@/admin/orders/orderModel";

export type OrderKey = { id: string } | { number: number };

interface OrderDetailContentProps {
  client: SupabaseClient;
  orderKey: OrderKey;
  role: AdminRole;
  actions: OrderActions;
  /** bump to reload (the board/history bumps it after every refresh or action) */
  version: number;
}

export const StatusBadge = ({ status, fulfillment }: { status: OrderStatus; fulfillment?: FulfillmentMethod }) => {
  const tone =
    status === "confirmed" ? "bg-brand-gold/20 text-brand-gold"
    : status === "completed" || status === "ready_for_pickup" ? "bg-brand-success/20 text-brand-success"
    : status === "cancelled" || status === "expired" || status === "delivery_failed" ? "bg-brand-danger/20 text-brand-danger"
    : "bg-brand-bg text-brand-text";
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{statusLabel(status, fulfillment)}</span>;
};

const ACTOR_LABEL: Record<string, string> = { system: "המערכת", customer: "הלקוח" };

function describeEvent(e: OrderEventRow, fulfillment?: FulfillmentMethod): string {
  switch (e.kind) {
    case "created":
      return "ההזמנה התקבלה";
    case "status":
      return `סטטוס: ${statusLabel(e.to_value as OrderStatus, fulfillment) ?? e.to_value}${e.reason ? ` — ${e.reason}` : ""}`;
    case "payment":
      return `תשלום: ${PAYMENT_STATUS_LABEL[e.to_value as PaymentStatus] ?? e.to_value}`;
    case "stock_return":
      return STOCK_RETURN_LABEL[e.to_value as StockReturnStatus] || e.to_value;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-brand-text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-brand-text">{children}</dd>
    </div>
  );
}

/** Everything about one order: customer + delivery details, items, money, and the full status timeline. */
export function OrderDetailContent({ client, orderKey, role, actions, version }: OrderDetailContentProps) {
  const [order, setOrder] = useState<OrderRow | null | undefined>(undefined);
  const [error, setError] = useState<OrderError | null>(null);
  const keyString = "id" in orderKey ? orderKey.id : String(orderKey.number);

  useEffect(() => {
    let cancelled = false;
    void loadOrderDetail(client, orderKey).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setOrder(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
    // orderKey is identified by keyString
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, keyString, version]);

  if (error && order === undefined) {
    return (
      <p role="alert" className="m-4 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
        {error.message}
      </p>
    );
  }
  if (order === undefined) {
    return (
      <div role="status" className="flex justify-center p-10 text-brand-gold">
        <Loader2 className="animate-spin" aria-label="טוען" />
      </div>
    );
  }
  if (order === null) {
    return <p className="m-4 text-sm text-brand-text-muted">ההזמנה לא נמצאה (או שאין הרשאה לצפות בה).</p>;
  }

  const details = addressDetails(order);
  const items = order.order_items ?? [];
  const events = order.order_status_events ?? [];

  return (
    <div className="space-y-5 p-4 text-brand-text" data-testid="order-detail">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-xl font-bold">#{order.order_number}</h3>
        <StatusBadge status={order.order_status} fulfillment={order.fulfillment_method} />
        <span className="text-sm text-brand-text-muted">{formatDateTime(order.created_at)}</span>
        {departureLabel(order) && <span className="rounded-full border border-brand-border px-2.5 py-0.5 text-xs text-brand-text">{departureLabel(order)}</span>}
      </header>

      {order.order_status === "delivery_failed" && (
        <p className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          המשלוח לא נמסר: {order.delivery_failed_reason}
          {order.stock_return_status !== "none" && <span className="block text-xs">{STOCK_RETURN_LABEL[order.stock_return_status]}</span>}
          {order.payment_status === "paid" && <span className="block text-xs">שולם בכרטיס אשראי — החזר כספי נעשה ידנית דרך ספק הסליקה.</span>}
        </p>
      )}

      {order.order_status === "cancelled" && (
        <p className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          בוטלה: {order.cancel_reason}
          {order.stock_return_status !== "none" && <span className="block text-xs">{STOCK_RETURN_LABEL[order.stock_return_status]}</span>}
        </p>
      )}
      {paidButDead(order) && (
        <p role="alert" className="rounded-md border border-brand-gold/50 bg-brand-gold/10 px-3 py-2 text-sm text-brand-gold">
          שולם בכרטיס אשראי אך ההזמנה לא פעילה — נדרש טיפול ידני (החזר כספי).
        </p>
      )}

      <OrderActionBar order={order} role={role} actions={actions} />
      {actions.error && (
        <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {actions.error.message}
        </p>
      )}

      <section aria-label={isPickup(order) ? "לקוח ואיסוף" : "לקוח ומשלוח"}>
        <h4 className="mb-2 text-sm font-semibold text-brand-gold">{isPickup(order) ? "לקוח ואיסוף" : "לקוח ומשלוח"}</h4>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="שם">{fullName(order)}</Field>
          <Field label="טלפון">
            <a href={`tel:${order.phone}`} className="inline-flex items-center gap-1 text-brand-gold hover:underline" dir="ltr">
              <Phone size={14} aria-hidden="true" />
              {order.phone}
            </a>
          </Field>
          <Field label={isPickup(order) ? "אופן קבלה" : "כתובת"}>{addressLine(order)}</Field>
          {details.length > 0 && <Field label="פרטי כניסה">{details.join(" · ")}</Field>}
          {order.delivery_notes && <Field label={isPickup(order) ? "הערות" : "הערות למשלוח"}>{order.delivery_notes}</Field>}
          {order.email && (
            <Field label="אימייל">
              <span dir="ltr">{order.email}</span>
            </Field>
          )}
        </dl>
      </section>

      <section aria-label="פריטים">
        <h4 className="mb-2 text-sm font-semibold text-brand-gold">פריטים</h4>
        <ul className="divide-y divide-brand-border rounded-lg border border-brand-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{item.product_name_snapshot}</div>
                <div className="text-xs text-brand-text-muted">
                  {item.product_brand_snapshot ? `${item.product_brand_snapshot} · ` : ""}
                  {item.option_label_snapshot}
                  {item.option === "package" ? ` (${item.base_units} יח׳)` : ""}
                </div>
              </div>
              <div className="shrink-0 text-end">
                <div>
                  {item.quantity} × {formatShekel(item.unit_price_cents)}
                </div>
                <div className="text-xs text-brand-text-muted">{formatShekel(item.line_total_cents)}</div>
              </div>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-brand-text-muted">סכום ביניים</dt>
            <dd>{formatShekel(order.subtotal_cents)}</dd>
          </div>
          {!isPickup(order) && (
            <div className="flex justify-between">
              <dt className="text-brand-text-muted">משלוח</dt>
              <dd>{formatShekel(order.delivery_fee_cents)}</dd>
            </div>
          )}
          {order.discount_cents > 0 && (
            <div className="flex justify-between">
              <dt className="text-brand-text-muted">
                הנחה{order.coupon_code_snapshot ? <> (קופון <span dir="ltr">{order.coupon_code_snapshot}</span>)</> : null}
              </dt>
              <dd>-{formatShekel(order.discount_cents)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-brand-border pt-1 text-base font-bold">
            <dt>סה״כ</dt>
            <dd className="text-brand-gold">{formatShekel(order.total_cents)}</dd>
          </div>
        </dl>
      </section>

      <section aria-label="תשלום">
        <h4 className="mb-2 text-sm font-semibold text-brand-gold">תשלום</h4>
        <dl className="grid grid-cols-2 gap-3">
          <Field label="אמצעי תשלום">{PAYMENT_METHOD_LABEL[order.payment_method]}</Field>
          <Field label="סטטוס תשלום">{PAYMENT_STATUS_LABEL[order.payment_status]}</Field>
        </dl>
      </section>

      <section aria-label="היסטוריית סטטוסים">
        <h4 className="mb-2 text-sm font-semibold text-brand-gold">היסטוריה</h4>
        <ol className="space-y-2 border-s border-brand-border ps-4">
          {events.map((e) => (
            <li key={e.id} className="text-sm">
              <div>{describeEvent(e, order.fulfillment_method)}</div>
              <div className="text-xs text-brand-text-muted">
                {formatDateTime(e.created_at)} · {ACTOR_LABEL[e.actor_label] ?? e.actor_label}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
