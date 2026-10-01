import { useCallback, useEffect, useState } from "react";
import { Button } from "@/shared/ui/Button";
import { useCart } from "@/storefront/context/CartContext";
import { useCatalog } from "@/storefront/context/CatalogContext";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { formatPrice, isOptionInStock } from "@/storefront/lib/pricing";
import { describeMemberError, getMyOrders, MemberApiError } from "@/account/memberApi";
import { formatOrderDate, orderAddressLine, orderStatusLabel, orderStatusTone, summarizeItems } from "@/account/orderLabels";
import type { MyOrder } from "@/account/types";
import { Card, Notice, Spinner } from "@/account/page/pageUi";
import { useMemberRun } from "@/account/page/useMemberRun";

const config = getCatalogConfig();

interface ReorderResult {
  orderId: string;
  added: number;
  skipped: string[];
}

const TONE_CLASSES = {
  active: "border-brand-gold/50 bg-brand-gold/10 text-brand-gold",
  done: "border-brand-border bg-brand-bg text-brand-text-muted",
  bad: "border-brand-danger/40 bg-brand-danger/10 text-brand-danger",
} as const;

/**
 * "ההזמנות שלי": the member's past orders (from get_my_orders(), which returns only what a customer should see) and
 * "הזמן שוב", which puts the same items back in the cart through the ordinary `addItem` — so the shared-stock check,
 * the live prices and the "unavailable" rules are exactly the ones a normal add-to-cart gets. Nothing is ordered here:
 * the customer reviews the cart and goes through checkout as always.
 */
export function OrdersTab() {
  const run = useMemberRun();
  const { addItem } = useCart();
  const { products, status: catalogStatus } = useCatalog();
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [result, setResult] = useState<ReorderResult | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setOrders(await run((token) => getMyOrders(config, token)));
    } catch (error) {
      setLoadError(error instanceof MemberApiError ? error.code : "NETWORK_ERROR");
    }
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  const reorder = async (order: MyOrder) => {
    setBusyOrderId(order.id);
    setResult(null);
    let added = 0;
    const skipped: string[] = [];
    // one at a time: each add is stock-checked against the cart as it is right now
    for (const item of order.items) {
      const product = item.productId ? products.find((candidate) => candidate.id === item.productId) : undefined;
      if (!product || !isOptionInStock(product, item.option)) {
        skipped.push(item.name);
        continue;
      }
      const ok = await addItem(product.id, item.option, item.quantity);
      if (ok) added += 1;
      else skipped.push(item.name);
    }
    setBusyOrderId(null);
    setResult({ orderId: order.id, added, skipped });
  };

  if (loadError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Notice kind="danger">{describeMemberError(loadError)}</Notice>
        <Button type="button" variant="outline" onClick={() => void load()}>
          נסו שוב
        </Button>
      </div>
    );
  }
  if (orders === null) return <Spinner />;
  if (orders.length === 0) {
    return (
      <Card>
        <p className="text-sm font-semibold text-brand-text">עדיין אין הזמנות</p>
        <p className="mt-1 text-sm text-brand-text-muted">הזמנות שתבצעו כחברי מועדון יופיעו כאן, וביום שתרצו אותן שוב, כפתור אחד יחזיר אותן לעגלה.</p>
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      {orders.map((order) => (
        <li key={order.id}>
          <Card className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-base font-semibold text-brand-text">הזמנה #{order.orderNumber}</span>
                <span className="text-xs text-brand-text-muted">{formatOrderDate(order.createdAt)}</span>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[orderStatusTone(order.status)]}`}>
                {orderStatusLabel(order.status)}
              </span>
            </div>

            <ul className="flex flex-col gap-0.5 text-sm text-brand-text">
              {order.items.map((item, index) => (
                <li key={`${item.productId ?? "x"}-${index}`}>
                  {item.quantity} × {item.name}
                  {item.option === "package" && item.optionLabel ? ` (${item.optionLabel})` : ""}
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-brand-text-muted">{orderAddressLine(order)}</span>
              <span className="font-semibold text-brand-gold">₪{formatPrice(order.totalCents)}</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busyOrderId !== null || catalogStatus !== "ready"}
                onClick={() => void reorder(order)}
                aria-label={`הזמן שוב את הזמנה ${order.orderNumber}: ${summarizeItems(order)}`}
              >
                {busyOrderId === order.id ? "מוסיפים לעגלה…" : "הזמן שוב"}
              </Button>
            </div>

            {result?.orderId === order.id && (
              <div className="flex flex-col gap-2">
                {result.added > 0 && (
                  <Notice kind="success">
                    {result.added === 1 ? "מוצר אחד נוסף לעגלה." : `${result.added} מוצרים נוספו לעגלה.`}
                  </Notice>
                )}
                {result.skipped.length > 0 && (
                  <Notice kind="danger">
                    לא נוסף לעגלה (אזל או שהכמות אינה זמינה כרגע): {result.skipped.join(", ")}.
                  </Notice>
                )}
                {result.added > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <a
                      href="/checkout"
                      className="inline-flex items-center justify-center rounded-md bg-brand-gold px-3 py-1.5 text-sm font-semibold text-brand-bg transition-colors hover:bg-brand-gold-hover"
                    >
                      מעבר לתשלום
                    </a>
                    <a href="/" className="inline-flex items-center justify-center rounded-md border border-brand-border px-3 py-1.5 text-sm text-brand-text transition-colors hover:border-brand-border-strong">
                      המשך קנייה
                    </a>
                  </div>
                )}
              </div>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}
