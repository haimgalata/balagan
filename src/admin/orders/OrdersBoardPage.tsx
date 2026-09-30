import { useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BellOff, BellRing, Loader2, Wifi, WifiOff, X } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import type { AdminRole } from "@/admin/useAdminSession";
import { OrderCard } from "@/admin/orders/OrderCard";
import { OrderDetailContent, StatusBadge } from "@/admin/orders/OrderDetailContent";
import { useActiveOrders, type Connection } from "@/admin/orders/useActiveOrders";
import { useNow } from "@/admin/orders/useNow";
import { useOrderActions } from "@/admin/orders/useOrderActions";
import { useOrderAlerts } from "@/admin/orders/useOrderAlerts";
import {
  STATUS_LABEL,
  addressLine,
  formatShekel,
  formatTime,
  fullName,
  paidButDead,
  type ActiveStatus,
  type OrderRow,
} from "@/admin/orders/orderModel";

const LANES: { status: ActiveStatus; title: string; empty: string }[] = [
  { status: "confirmed", title: STATUS_LABEL.confirmed, empty: "אין הזמנות חדשות" },
  { status: "preparing", title: STATUS_LABEL.preparing, empty: "אין הזמנות בהכנה" },
  { status: "out_for_delivery", title: STATUS_LABEL.out_for_delivery, empty: "אין הזמנות בדרך" },
];

interface CancelNotice {
  id: string;
  orderNumber: number;
  reason: string | null;
  wasOut: boolean;
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const [text, tone, Icon] =
    connection === "live" ? (["מחובר בזמן אמת", "text-brand-success", Wifi] as const)
    : connection === "connecting" ? (["מתחבר…", "text-brand-text-muted", Loader2] as const)
    : connection === "reconnecting" ? (["חיבור בזמן אמת נותק — מתעדכן כל 30 שניות", "text-brand-gold", WifiOff] as const)
    : (["אין חיבור לשרת", "text-brand-danger", WifiOff] as const);
  return (
    <span role="status" data-testid="connection-status" data-connection={connection} className={`inline-flex items-center gap-1.5 text-sm ${tone}`}>
      <Icon size={16} className={connection === "connecting" ? "animate-spin" : ""} aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * The Active board — meant to stay open all day on the order terminal. Three lanes (new / preparing / out for
 * delivery), an alert that keeps ringing until every new order has been accepted, a connection indicator, and
 * today's finished orders underneath. Data + Realtime live in `useActiveOrders`; sound in `useOrderAlerts`.
 */
export function OrdersBoardPage({ client, role }: { client: SupabaseClient; role: AdminRole }) {
  const { data, error, connection, refresh } = useActiveOrders(client);
  const actions = useOrderActions(client, refresh);
  const now = useNow(30_000);
  const [openOrder, setOpenOrder] = useState<OrderRow | null>(null);
  const [notices, setNotices] = useState<CancelNotice[]>([]);
  const [detailVersion, setDetailVersion] = useState(0);

  const waitingIds = useMemo(() => (data?.active ?? []).filter((o) => o.order_status === "confirmed").map((o) => o.id), [data]);
  const alerts = useOrderAlerts(waitingIds);

  // Any refresh also refreshes an open detail panel.
  useEffect(() => setDetailVersion((v) => v + 1), [data]);

  // An order that was open on this screen and turns up cancelled — by someone ELSE — is called out loudly.
  const previouslyActive = useRef(new Map<string, OrderRow["order_status"]>());
  useEffect(() => {
    if (!data) return;
    const found: CancelNotice[] = [];
    for (const o of [...data.finishedToday, ...data.awaitingReturn]) {
      const before = previouslyActive.current.get(o.id);
      if (o.order_status === "cancelled" && before && !actions.actedIds.current.has(o.id)) {
        found.push({ id: o.id, orderNumber: o.order_number, reason: o.cancel_reason, wasOut: before === "out_for_delivery" });
      }
    }
    previouslyActive.current = new Map(data.active.map((o) => [o.id, o.order_status]));
    if (found.length > 0) {
      setNotices((current) => [...current, ...found.filter((f) => !current.some((c) => c.id === f.id))]);
      alerts.playWarning();
    }
    // playWarning changes identity with sound state; only new data should trigger this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const lanes = useMemo(
    () => LANES.map((lane) => ({ ...lane, orders: (data?.active ?? []).filter((o) => o.order_status === lane.status) })),
    [data]
  );
  const attention = useMemo(() => {
    const seen = new Set<string>();
    return [...(data?.awaitingReturn ?? []), ...(data?.finishedToday ?? []).filter(paidButDead)].filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
  }, [data]);
  const finished = (data?.finishedToday ?? []).filter((o) => !attention.some((a) => a.id === o.id));

  return (
    <div className="space-y-4" data-testid="orders-board">
      {/* status strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated px-3 py-2">
        <ConnectionBadge connection={connection} />
        <div className="flex items-center gap-2">
          {alerts.soundOn ? (
            <Button size="sm" variant="secondary" onClick={alerts.toggleMute} aria-pressed={alerts.muted}>
              {alerts.muted ? <BellOff size={16} aria-hidden="true" /> : <BellRing size={16} aria-hidden="true" />}
              {alerts.muted ? "מושתק — להפעלת צליל" : "השתקה"}
            </Button>
          ) : (
            <Button size="sm" onClick={alerts.startShift}>
              <BellRing size={16} aria-hidden="true" />
              התחלת משמרת (הפעלת צליל)
            </Button>
          )}
        </div>
      </div>

      {!alerts.soundOn && (
        <p role="alert" data-testid="sound-off-banner" className="rounded-md border border-brand-gold/50 bg-brand-gold/10 px-3 py-2 text-sm text-brand-gold">
          הצליל כבוי — הזמנה חדשה לא תישמע. לחצו על ״התחלת משמרת״ (נדרש אחרי כל טעינה מחדש של הדף).
        </p>
      )}
      {connection === "offline" && (
        <p role="alert" className="rounded-md border border-brand-danger/50 bg-brand-danger/10 px-3 py-2 text-sm font-medium text-brand-danger">
          אין חיבור לשרת — הזמנות חדשות עלולות לא להופיע. בדקו את האינטרנט.
        </p>
      )}
      {error && !data && (
        <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {error.message}
        </p>
      )}
      {actions.error && (
        <p role="alert" data-testid="action-error" className="flex items-start justify-between gap-2 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {actions.error.message}
          <button type="button" aria-label="סגירה" onClick={actions.clearError}>
            <X size={16} />
          </button>
        </p>
      )}
      {notices.map((n) => (
        <p key={n.id} role="alert" data-testid="cancel-notice" className="flex items-start justify-between gap-2 rounded-md border border-brand-danger bg-brand-danger/15 px-3 py-2 text-sm text-brand-text">
          <span>
            <strong>הזמנה #{n.orderNumber} בוטלה</strong>
            {n.reason ? ` — ${n.reason}` : ""}
            {n.wasOut ? " (היא כבר יצאה למשלוח — יש להחזיר את המוצרים)" : ""}
          </span>
          <button type="button" aria-label="הבנתי" onClick={() => setNotices((c) => c.filter((x) => x.id !== n.id))}>
            <X size={16} />
          </button>
        </p>
      ))}

      {!data && !error && (
        <div role="status" className="flex justify-center p-10 text-brand-gold">
          <Loader2 className="animate-spin" aria-label="טוען" />
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            {lanes.map((lane) => (
              <section key={lane.status} aria-label={lane.title} data-testid={`lane-${lane.status}`}>
                <h2 className="mb-2 flex items-center justify-between text-base font-semibold text-brand-text">
                  {lane.title}
                  <span className={`rounded-full px-2.5 py-0.5 text-sm ${lane.orders.length > 0 && lane.status === "confirmed" ? "bg-brand-gold text-brand-bg" : "bg-brand-bg-elevated text-brand-text-muted"}`}>{lane.orders.length}</span>
                </h2>
                <div className="space-y-3">
                  {lane.orders.length === 0 && <p className="rounded-lg border border-dashed border-brand-border p-4 text-center text-sm text-brand-text-muted">{lane.empty}</p>}
                  {lane.orders.map((order) => (
                    <OrderCard key={order.id} order={order} role={role} actions={actions} now={now} onOpen={setOpenOrder} />
                  ))}
                </div>
              </section>
            ))}
          </div>

          {attention.length > 0 && (
            <section aria-label="דורש טיפול" data-testid="needs-attention" className="rounded-xl border border-brand-danger/60 p-3">
              <h2 className="mb-2 text-base font-semibold text-brand-danger">דורש טיפול ({attention.length})</h2>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {attention.map((order) => (
                  <OrderCard key={order.id} order={order} role={role} actions={actions} now={now} onOpen={setOpenOrder} />
                ))}
              </div>
            </section>
          )}

          <details className="rounded-xl border border-brand-border bg-brand-bg-elevated" data-testid="finished-today">
            <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-brand-text">הושלמו / בוטלו היום ({finished.length})</summary>
            {finished.length === 0 ? (
              <p className="px-3 pb-3 text-sm text-brand-text-muted">עדיין אין הזמנות שהסתיימו היום.</p>
            ) : (
              <ul className="divide-y divide-brand-border">
                {finished.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => setOpenOrder(o)} className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-start text-sm hover:bg-brand-bg">
                      <span className="flex items-center gap-2">
                        <strong>#{o.order_number}</strong>
                        <span>{fullName(o)}</span>
                        <span className="text-brand-text-muted">{addressLine(o)}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-brand-text-muted">{formatTime(o.status_changed_at)}</span>
                        <span>{formatShekel(o.total_cents)}</span>
                        <StatusBadge status={o.order_status} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}

      <Drawer isOpen={openOrder !== null} onClose={() => setOpenOrder(null)} title={openOrder ? `הזמנה #${openOrder.order_number}` : "הזמנה"} side="left" widthClassName="max-w-xl">
        {openOrder && <OrderDetailContent client={client} orderKey={{ id: openOrder.id }} role={role} actions={actions} version={detailVersion} />}
      </Drawer>
    </div>
  );
}
