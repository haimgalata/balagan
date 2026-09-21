import { useEffect, useState } from "react";
import { normalizeAdminPath } from "@/admin/adminRoute";

/**
 * Tiny path handling inside the admin area (no router dependency). Admin-only code — lazy loaded with the
 * admin app. The pure address checks live in `adminRoute.ts` (the only admin file the customer bundle has).
 */
export { ADMIN_ROOT, isAdminPathname, normalizeAdminPath } from "@/admin/adminRoute";

/** Client-side navigation inside the admin (keeps the page, updates the URL, notifies listeners). */
export function navigateAdmin(to: string): void {
  if (window.location.pathname !== to) window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Current admin path, kept in sync with back/forward and `navigateAdmin`. */
export function useAdminPath(): string {
  const [path, setPath] = useState(() => normalizeAdminPath(window.location.pathname));
  useEffect(() => {
    const update = () => setPath(normalizeAdminPath(window.location.pathname));
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return path;
}

