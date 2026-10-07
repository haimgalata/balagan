import { lazy, Suspense, useState } from "react";
import { readLastOrder } from "@/order/lastOrder";

const LastOrderStrip = lazy(() => import("@/order/LastOrderStrip"));

/**
 * Homepage hook-in for the "your order" strip: reads the (tiny) last-order note from this device and only then loads
 * the strip itself, so a visitor with no recent order downloads and requests nothing extra.
 */
export function LastOrderStripLoader() {
  const [order] = useState(readLastOrder);
  if (!order) return null;
  return (
    <Suspense fallback={null}>
      <LastOrderStrip order={order} />
    </Suspense>
  );
}
