import { useEffect } from "react";
import { BusinessSettingsProvider } from "@/storefront/context/BusinessSettingsContext";
import { OrderStatusPage } from "@/order/OrderStatusPage";
import { orderIdFromPathname } from "@/order/orderRoute";

/**
 * Root of `/order/<id>`. Loaded lazily by `src/main.tsx` only for that address, like `/checkout`. Needs only the
 * business settings (store address and hours for a pickup order) — not the catalog or the cart.
 */
export default function OrderApp() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow,noarchive";
    document.head.appendChild(meta);
    const previousTitle = document.title;
    document.title = "מעקב הזמנה · בלאגן";
    return () => {
      meta.remove();
      document.title = previousTitle;
    };
  }, []);

  return (
    <BusinessSettingsProvider>
      <OrderStatusPage orderId={orderIdFromPathname(window.location.pathname)} />
    </BusinessSettingsProvider>
  );
}
