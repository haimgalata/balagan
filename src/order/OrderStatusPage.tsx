import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, Loader2, Store } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { formatPrice } from "@/storefront/lib/pricing";
import { getOrderingRules } from "@/storefront/lib/fulfillment";
import { useBusinessSettings } from "@/storefront/context/BusinessSettingsContext";
import { useStoreStatus } from "@/storefront/hooks/useStoreStatus";
import { fetchOrderStatus, type PublicOrderStatus } from "@/order/orderStatusApi";
import { customerStatusLabel, isOpenOrderStatus } from "@/order/orderStatusText";
import { forgetLastOrder, readLastOrder } from "@/order/lastOrder";

const STORE_PHONE = "08-994-5190";
const STORE_PHONE_HREF = "tel:089945190";
const POLL_MS = 30_000;

const config = getCatalogConfig();

type Load =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "failed" }
  | { phase: "ready"; order: PublicOrderStatus };

function Header() {
  return (
    <header className="border-b border-brand-tobacco-strong bg-brand-bg-secondary">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
        <a
          href="/"
          className="flex items-center gap-1.5 rounded-md p-1 text-sm text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
        >
          <ArrowRight size={18} />
          לחנות
        </a>
        <span className="font-display text-xl text-brand-gold">בלאגן</span>
      </div>
    </header>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-4 text-center">{children}</div>;
}

/** The steps an order moves through, for this order's way of being received. */
function stepsFor(order: PublicOrderStatus): string[] {
  return order.fulfillmentMethod === "pickup"
    ? ["confirmed", "preparing", "ready_for_pickup", "completed"]
    : ["confirmed", "preparing", "out_for_delivery", "completed"];
}

function Steps({ order }: { order: PublicOrderStatus }) {
  const steps = stepsFor(order);
  const current = steps.indexOf(order.orderStatus);
  return (
    <ol className="flex flex-col gap-3" aria-label="שלבי ההזמנה">
      {steps.map((step, index) => {
        const done = index < current || (index === current && step === "completed");
        const active = index === current && step !== "completed";
        return (
          <li key={step} className="flex items-center gap-3" aria-current={active ? "step" : undefined}>
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                done
                  ? "border-brand-success bg-brand-success/15 text-brand-success"
                  : active
                    ? "border-brand-gold bg-brand-gold/15 text-brand-gold"
                    : "border-brand-border text-brand-text-muted"
              }`}
            >
              {done ? <Check size={14} aria-hidden="true" /> : index + 1}
            </span>
            <span className={`text-sm ${active ? "font-semibold text-brand-text" : done ? "text-brand-text" : "text-brand-text-muted"}`}>
              {customerStatusLabel(step, order.fulfillmentMethod)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function PickupCard({ ready }: { ready: boolean }) {
  const { settings } = useBusinessSettings();
  const { storeAddress } = getOrderingRules(settings);
  const store = useStoreStatus();
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${ready ? "border-brand-success/60 bg-brand-success/10" : "border-brand-border bg-brand-bg-elevated"}`}
      data-testid="pickup-card"
    >
      <Store size={22} className={`mt-0.5 shrink-0 ${ready ? "text-brand-success" : "text-brand-gold"}`} aria-hidden="true" />
      <div className="flex flex-col gap-0.5 text-sm text-brand-text">
        <span className="font-semibold">{ready ? "ההזמנה מוכנה — אפשר לבוא לאסוף!" : "איסוף עצמי מהחנות"}</span>
        {storeAddress && <span>{storeAddress}</span>}
        <span className="text-xs text-brand-text-muted">
          {store.isOpen ? `החנות פתוחה עכשיו (${store.hoursLabel})` : `החנות סגורה כרגע · היום: ${store.hoursLabel}`}
        </span>
        <span className="text-xs text-brand-text-muted">יש להציג תעודה מזהה בעת האיסוף.</span>
      </div>
    </div>
  );
}

/**
 * `/order/<id>`: where a customer follows their order — "התקבלה → בהכנה → מוכנה לאיסוף → נאספה" (or the delivery steps).
 * Reads `get_order_status()` on load, every 30 seconds while the tab is visible and the order is still open, and
 * whenever the tab becomes visible again. Read-only: nothing here changes an order.
 */
export function OrderStatusPage({ orderId }: { orderId: string | null }) {
  const [load, setLoad] = useState<Load>(orderId ? { phase: "loading" } : { phase: "missing" });
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!orderId || inFlight.current) return;
    inFlight.current = true;
    try {
      const order = await fetchOrderStatus(config, orderId);
      setLoad(order ? { phase: "ready", order } : { phase: "missing" });
      // a finished order no longer needs the homepage strip
      if (order && !isOpenOrderStatus(order.orderStatus) && readLastOrder()?.id === orderId) forgetLastOrder();
    } catch {
      // keep showing what we last knew; only a first load without anything turns into the error screen
      setLoad((previous) => (previous.phase === "ready" ? previous : { phase: "failed" }));
    } finally {
      inFlight.current = false;
    }
  }, [orderId]);

  const open = load.phase === "ready" ? isOpenOrderStatus(load.order.orderStatus) : load.phase !== "missing";

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, refresh]);

  return (
    <div className="min-h-screen bg-brand-bg">
      <Header />
      <main className="mx-auto max-w-2xl px-4 py-8">
        {load.phase === "loading" && (
          <Centered>
            <Loader2 size={28} className="animate-spin text-brand-gold" aria-hidden="true" />
            <p className="text-sm text-brand-text-muted">טוען את ההזמנה…</p>
          </Centered>
        )}
        {load.phase === "missing" && (
          <Centered>
            <h1 className="text-lg font-semibold text-brand-text">ההזמנה לא נמצאה</h1>
            <p className="max-w-sm text-sm text-brand-text-muted">
              בדקו שהקישור מלא ונכון, או התקשרו לחנות:{" "}
              <a href={STORE_PHONE_HREF} className="text-brand-gold underline underline-offset-2">
                {STORE_PHONE}
              </a>
            </p>
          </Centered>
        )}
        {load.phase === "failed" && (
          <Centered>
            <h1 className="text-lg font-semibold text-brand-text">לא ניתן לטעון את ההזמנה כרגע</h1>
            <p className="max-w-sm text-sm text-brand-text-muted">בדקו את החיבור לאינטרנט ונסו שוב.</p>
            <Button onClick={() => void refresh()}>נסו שוב</Button>
          </Centered>
        )}
        {load.phase === "ready" && <OrderView order={load.order} />}
      </main>
    </div>
  );
}

function OrderView({ order }: { order: PublicOrderStatus }) {
  const pickup = order.fulfillmentMethod === "pickup";
  const status = order.orderStatus;
  const dead = status === "cancelled" || status === "expired";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold text-brand-text">הזמנה #{order.orderNumber}</h1>
          <span className="text-sm text-brand-text-muted">₪{formatPrice(order.totalCents)}</span>
        </div>
        <span
          role="status"
          className={`rounded-full border px-3 py-1 text-sm font-medium ${
            dead
              ? "border-brand-danger/40 bg-brand-danger/10 text-brand-danger"
              : status === "ready_for_pickup" || status === "completed"
                ? "border-brand-success/40 bg-brand-success/10 text-brand-success"
                : "border-brand-gold/40 bg-brand-gold/10 text-brand-gold"
          }`}
        >
          {customerStatusLabel(status, order.fulfillmentMethod)}
        </span>
      </div>

      {status === "pending" && (
        <p className="rounded-lg border border-brand-border bg-brand-bg-elevated px-3 py-2 text-sm text-brand-text-muted">
          ההזמנה ממתינה להשלמת התשלום.
        </p>
      )}

      {dead ? (
        <p className="rounded-lg border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {status === "cancelled" ? "ההזמנה בוטלה." : "ההזמנה לא הושלמה (פג הזמן לתשלום)."} לשאלות:{" "}
          <a href={STORE_PHONE_HREF} className="underline underline-offset-2">
            {STORE_PHONE}
          </a>
        </p>
      ) : (
        status !== "pending" && (
          <div className="rounded-2xl border border-brand-border bg-brand-bg-elevated p-4">
            <Steps order={order} />
          </div>
        )
      )}

      {pickup && !dead && status !== "completed" && <PickupCard ready={status === "ready_for_pickup"} />}

      {!dead && status !== "completed" && (
        <p className="text-xs text-brand-text-muted">העמוד מתעדכן מעצמו. אפשר לשמור אותו ולחזור אליו בכל רגע.</p>
      )}

      <p className="text-sm text-brand-text-muted">
        שאלות לגבי ההזמנה?{" "}
        <a href={STORE_PHONE_HREF} className="text-brand-gold underline underline-offset-2">
          {STORE_PHONE}
        </a>
      </p>
    </div>
  );
}
