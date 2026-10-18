import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2, LogOut } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { ADMIN_ROOT, navigateAdmin, useAdminPath } from "@/admin/adminPath";
import { CategoriesPage } from "@/admin/categories/CategoriesPage";
import { ProductsPage } from "@/admin/products/ProductsPage";
import { BusinessSettingsPage } from "@/admin/settings/BusinessSettingsPage";
import { OrdersPage } from "@/admin/orders/OrdersPage";
import { CustomersPage } from "@/admin/customers/CustomersPage";
import { CUSTOMERS_PATH } from "@/admin/customers/customersRoute";
import { CouponsPage } from "@/admin/coupons/CouponsPage";
import { COUPONS_PATH } from "@/admin/coupons/couponsRoute";
import { CostsPage } from "@/admin/costs/CostsPage";
import { ScanPage } from "@/admin/costs/ScanPage";
import { COSTS_PATH, SCAN_PATH } from "@/admin/costs/costsRoute";
import { ORDERS_PATH, isOrdersPath } from "@/admin/orders/ordersRoute";
import type { AdminRole } from "@/admin/useAdminSession";

interface AdminShellProps {
  email: string;
  role: AdminRole;
  client: SupabaseClient;
  onSignOut: () => void;
}

/** Sections of the dashboard. `ownerOnly` sections are hidden from staff (the database refuses them anyway). */
const NAV_ITEMS = [
  { label: "ראשי", path: ADMIN_ROOT, enabled: true, ownerOnly: true },
  { label: "הזמנות", path: ORDERS_PATH, enabled: true, ownerOnly: false },
  { label: "קטגוריות", path: `${ADMIN_ROOT}/categories`, enabled: true, ownerOnly: true },
  { label: "מוצרים", path: `${ADMIN_ROOT}/products`, enabled: true, ownerOnly: true },
  { label: "לקוחות", path: CUSTOMERS_PATH, enabled: true, ownerOnly: true },
  { label: "קופונים", path: COUPONS_PATH, enabled: true, ownerOnly: true },
  { label: "עלויות ורווח", path: COSTS_PATH, enabled: true, ownerOnly: true },
  { label: "סריקה", path: SCAN_PATH, enabled: true, ownerOnly: true },
  { label: "הגדרות עסק", path: `${ADMIN_ROOT}/settings`, enabled: true, ownerOnly: true },
] as const;

const SUMMARY_TABLES = [
  { table: "categories", label: "קטגוריות" },
  { table: "subcategories", label: "תתי־קטגוריות" },
  { table: "products", label: "מוצרים (כולל מוסתרים)" },
] as const;

type SummaryState = { status: "loading" } | { status: "error" } | { status: "ready"; counts: number[] };

/**
 * Read-only counts straight from the admin-only tables. Anonymous visitors and non-admin accounts cannot
 * read these (Row Level Security), so seeing numbers here proves the guard AND the database rules work
 * end to end. Includes hidden items, which the public catalog never shows.
 */
function AdminSummary({ client }: { client: SupabaseClient }) {
  const [summary, setSummary] = useState<SummaryState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.all(SUMMARY_TABLES.map(({ table }) => client.from(table).select("id", { count: "exact", head: true })))
      .then((results) => {
        if (cancelled) return;
        if (results.some((result) => result.error)) setSummary({ status: "error" });
        else setSummary({ status: "ready", counts: results.map((result) => result.count ?? 0) });
      })
      .catch(() => {
        if (!cancelled) setSummary({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (summary.status === "error") {
    return (
      <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
        לא ניתן לטעון את הנתונים כרגע.
      </p>
    );
  }

  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {SUMMARY_TABLES.map(({ label }, index) => (
        <div key={label} className="rounded-lg border border-brand-border bg-brand-bg-elevated p-4">
          <dt className="text-sm text-brand-text-muted">{label}</dt>
          <dd className="mt-1 text-2xl font-bold text-brand-gold">
            {summary.status === "ready" ? (
              summary.counts[index]
            ) : (
              <Loader2 size={22} className="animate-spin" aria-label="טוען" />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function NotFound() {
  return (
    <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center">
      <p className="mb-4 text-brand-text">העמוד לא נמצא.</p>
      <Button variant="secondary" onClick={() => navigateAdmin(ADMIN_ROOT)}>
        חזרה לראשי
      </Button>
    </div>
  );
}

/** The signed-in admin frame: header (who is signed in + sign out), section navigation and the current page. */
export function AdminShell({ email, role, client, onSignOut }: AdminShellProps) {
  const path = useAdminPath();
  const onOrders = isOrdersPath(path);
  const navItems = NAV_ITEMS.filter((item) => role === "owner" || !item.ownerOnly);

  // Staff only ever work in Orders: anywhere else in /admin sends them there. (UX — every other table and
  // function refuses a staff session at the database regardless.)
  const staffOutsideOrders = role === "staff" && !onOrders;
  useEffect(() => {
    if (staffOutsideOrders) navigateAdmin(ORDERS_PATH);
  }, [staffOutsideOrders]);

  // On a phone the menu is a scrolling strip: keep the current section in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const current = navRef.current?.querySelector('[aria-current="page"]');
    if (current && typeof (current as HTMLElement).scrollIntoView === "function") (current as HTMLElement).scrollIntoView({ block: "nearest", inline: "center" });
  }, [path]);
  if (staffOutsideOrders) return null;

  return (
    <div className="min-h-screen bg-brand-bg text-brand-text">
      <header className="border-b border-brand-border bg-brand-bg-elevated">
        <div className="mx-auto flex max-w-container items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-xl text-brand-gold">בלאגן</span>
            <span className="text-sm font-medium text-brand-text-muted">{role === "staff" ? "הזמנות" : "ניהול"}</span>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span dir="ltr" className="min-w-0 max-w-[9.5rem] truncate text-xs text-brand-text-muted sm:max-w-xs sm:text-sm" data-testid="admin-email">
              {email}
            </span>
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              <LogOut size={16} aria-hidden="true" />
              התנתקות
            </Button>
          </div>
        </div>

        <nav ref={navRef} aria-label="ניווט ניהול" className="mx-auto flex max-w-container gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden">
          {navItems.map((item) =>
            item.enabled ? (
              <a
                key={item.path}
                href={item.path}
                aria-current={item.path === ORDERS_PATH ? (onOrders ? "page" : undefined) : path === item.path ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigateAdmin(item.path);
                }}
                className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-gold ${
                  (item.path === ORDERS_PATH ? onOrders : path === item.path)
                    ? "border-brand-gold text-brand-gold"
                    : "border-transparent text-brand-text-muted hover:text-brand-text"
                }`}
              >
                {item.label}
              </a>
            ) : (
              <span
                key={item.path}
                aria-disabled="true"
                className="flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm text-brand-text-muted/60"
              >
                {item.label}
                <span className="rounded bg-brand-bg px-1.5 py-0.5 text-[10px]">בקרוב</span>
              </span>
            )
          )}
        </nav>
      </header>

      <main className={`mx-auto px-4 py-6 sm:px-6 ${onOrders ? "max-w-[112rem]" : "max-w-container"}`}>
        {onOrders ? (
          <OrdersPage client={client} role={role} path={path} />
        ) : path === ADMIN_ROOT ? (
          <>
            <h1 className="mb-4 text-xl font-bold text-brand-text">סקירה</h1>
            <AdminSummary client={client} />
          </>
        ) : path === `${ADMIN_ROOT}/categories` ? (
          <CategoriesPage client={client} />
        ) : path === `${ADMIN_ROOT}/products` ? (
          <ProductsPage client={client} />
        ) : path === CUSTOMERS_PATH ? (
          <CustomersPage client={client} />
        ) : path === COUPONS_PATH ? (
          <CouponsPage client={client} />
        ) : path === COSTS_PATH ? (
          <CostsPage client={client} />
        ) : path === SCAN_PATH ? (
          <ScanPage client={client} />
        ) : path === `${ADMIN_ROOT}/settings` ? (
          <BusinessSettingsPage client={client} />
        ) : (
          <NotFound />
        )}
      </main>
    </div>
  );
}
