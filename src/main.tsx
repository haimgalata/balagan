import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { isAdminPathname } from "./admin/adminRoute";
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
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
