import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { isAdminPathname } from "./admin/adminRoute";
import { isCheckoutPathname } from "./checkout/checkoutRoute";
import { isAccountPathname } from "./account/accountRoute";
import "./index.css";

const root = createRoot(document.getElementById("root")!);

if (isAdminPathname(window.location.pathname)) {
  // Private admin area (reached only by typing /admin — nothing on the site links to it). Loaded on demand
  // so its code, including the Supabase client, is never part of what customers download.
  void import("./admin/AdminApp").then(({ default: AdminApp }) => {
    root.render(
      <StrictMode>
        <AdminApp />
      </StrictMode>
    );
  });
} else if (isCheckoutPathname(window.location.pathname)) {
  // Checkout (reached from the cart's "מעבר לתשלום"). Loaded on demand too, same reasoning as admin.
  void import("./checkout/CheckoutApp").then(({ default: CheckoutApp }) => {
    root.render(
      <StrictMode>
        <CheckoutApp />
      </StrictMode>
    );
  });
} else if (__CUSTOMER_AUTH__ !== "off" && isAccountPathname(window.location.pathname)) {
  // The club member's personal area. Only exists in builds with a club login (a compile-time constant): in a build
  // without one this branch is removed, and /account is just the homepage like any other unknown address.
  void import("./account/AccountApp").then(({ default: AccountApp }) => {
    root.render(
      <StrictMode>
        <AccountApp />
      </StrictMode>
    );
  });
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
