import { useEffect } from "react";
import { CatalogProvider } from "@/storefront/context/CatalogContext";
import { BusinessSettingsProvider } from "@/storefront/context/BusinessSettingsContext";
import { CartProvider } from "@/storefront/context/CartContext";
import { Toast } from "@/storefront/components/Toast";
import { CustomerSessionProvider } from "@/account/CustomerSessionContext";
import { AccountPage } from "@/account/page/AccountPage";

/**
 * Root of `/account`. Loaded lazily by `src/main.tsx` only when the address is under `/account` AND this build has a
 * club login (see `__CUSTOMER_AUTH__`), the same on-demand pattern as `/checkout` and `/admin`. It shares the storefront's
 * catalog and cart providers — "order again" puts items into the very same cart (same localStorage, same live prices and
 * stock check) that the homepage and checkout use.
 */
export default function AccountApp() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow,noarchive";
    document.head.appendChild(meta);
    const previousTitle = document.title;
    document.title = "האזור האישי · בלאגן";
    return () => {
      meta.remove();
      document.title = previousTitle;
    };
  }, []);

  return (
    <CatalogProvider>
      <BusinessSettingsProvider>
        <CartProvider>
          <CustomerSessionProvider>
            <AccountPage />
          </CustomerSessionProvider>
          <Toast />
        </CartProvider>
      </BusinessSettingsProvider>
    </CatalogProvider>
  );
}
