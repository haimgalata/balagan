import { useEffect, useState } from "react";
import { ChevronLeft, PackageCheck } from "lucide-react";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { fetchOrderStatus, type PublicOrderStatus } from "@/order/orderStatusApi";
import { customerStatusLabel, isOpenOrderStatus } from "@/order/orderStatusText";
import { forgetLastOrder, type LastOrder } from "@/order/lastOrder";
import { orderPath } from "@/order/orderRoute";

const config = getCatalogConfig();
const POLL_MS = 60_000;

/**
 * A thin strip at the top of the homepage while an order placed on this device is still open: "הזמנה #1042 · מוכנה
 * לאיסוף" with a link to its tracking page. Loaded on demand (see LastOrderStripLoader) only when such an order is
 * remembered, so a normal visit pays nothing for it. Disappears — and forgets the order — once it is finished.
 */
export default function LastOrderStrip({ order }: { order: LastOrder }) {
  const [status, setStatus] = useState<PublicOrderStatus | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await fetchOrderStatus(config, order.id);
        if (!alive) return;
        if (!next || !isOpenOrderStatus(next.orderStatus)) {
          forgetLastOrder();
          setGone(true);
          return;
        }
        setStatus(next);
      } catch {
        /* offline: show nothing new, try again on the next tick */
      }
    };
    void load();
    const tick = window.setInterval(() => void load(), POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", load);
    };
  }, [order.id]);

  if (gone || !status) return null;
  const ready = status.orderStatus === "ready_for_pickup";

  return (
    <a
      href={orderPath(order.id)}
      data-testid="last-order-strip"
      className={`flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-gold ${
        ready ? "bg-brand-success/15 text-brand-success" : "bg-brand-gold/10 text-brand-gold"
      }`}
    >
      <PackageCheck size={16} aria-hidden="true" />
      <span>
        הזמנה #{status.orderNumber} · {customerStatusLabel(status.orderStatus, status.fulfillmentMethod)}
        {ready ? " — אפשר לבוא לאסוף" : ""}
      </span>
      <ChevronLeft size={16} aria-hidden="true" />
    </a>
  );
}
