import { useEffect } from "react";
import { CatalogProvider } from "@/storefront/context/CatalogContext";
import { BusinessSettingsProvider } from "@/storefront/context/BusinessSettingsContext";
import { CartProvider } from "@/storefront/context/CartContext";
import { Toast } from "@/storefront/components/Toast";
import { CheckoutPage } from "@/checkout/CheckoutPage";

/**
 * Root of `/checkout`. Loaded lazily by `src/main.tsx` only when the address is under `/checkout`, the same
 * way `/admin` is — most visits never reach checkout, so its details-form code shouldn't cost anyone just
 * browsing the catalog. Shares the same three providers `App.tsx` uses so cart/catalog/business-settings
 * state is identical to the homepage's (same localStorage, same live prices).
 */
export default function CheckoutApp() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow,noarchive";
    document.head.appendChild(meta);
    const previousTitle = document.title;
    document.title = "השלמת הזמנה · בלאגן";
    return () => {
      meta.remove();
      document.title = previousTitle;
    };
  }, []);

  return (
    <CatalogProvider>
      <BusinessSettingsProvider>
        <CartProvider>
          <CheckoutPage />
          <Toast />
        </CartProvider>
      </BusinessSettingsProvider>
    </CatalogProvider>
  );
}
