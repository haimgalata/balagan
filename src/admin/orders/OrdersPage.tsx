import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowRight } from "lucide-react";
import type { AdminRole } from "@/admin/useAdminSession";
import { navigateAdmin } from "@/admin/adminPath";
import { OrderDetailContent } from "@/admin/orders/OrderDetailContent";
import { OrdersBoardPage } from "@/admin/orders/OrdersBoardPage";
import { OrdersHistoryPage } from "@/admin/orders/OrdersHistoryPage";
import { parseOrdersPath, ORDERS_PATH, ORDERS_HISTORY_PATH } from "@/admin/orders/ordersRoute";
import { useOrderActions } from "@/admin/orders/useOrderActions";
import { useCallback, useState } from "react";

function OrderPageByNumber({ client, role, number }: { client: SupabaseClient; role: AdminRole; number: number }) {
  const [version, setVersion] = useState(0);
  const actions = useOrderActions(client, useCallback(async () => setVersion((v) => v + 1), []));
  return (
    <div>
      <a
        href={ORDERS_PATH}
        onClick={(event) => {
          event.preventDefault();
          navigateAdmin(ORDERS_PATH);
        }}
        className="mb-2 inline-flex items-center gap-1 text-sm text-brand-gold hover:underline"
      >
        <ArrowRight size={16} aria-hidden="true" />
        חזרה להזמנות
      </a>
      <div className="mx-auto max-w-2xl rounded-xl border border-brand-border bg-brand-bg-elevated">
        <OrderDetailContent client={client} orderKey={{ number }} role={role} actions={actions} version={version} />
      </div>
    </div>
  );
}

const TABS = [
  { view: "board", label: "הזמנות פעילות", path: ORDERS_PATH },
  { view: "history", label: "היסטוריה וחיפוש", path: ORDERS_HISTORY_PATH },
] as const;

/** `/admin/orders` — the Active board, `/admin/orders/history` — history & search, `/admin/orders/<number>` — one order. */
export function OrdersPage({ client, role, path }: { client: SupabaseClient; role: AdminRole; path: string }) {
  const route = parseOrdersPath(path);

  if (route.view === "order") return <OrderPageByNumber client={client} role={role} number={route.number} />;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-brand-text">הזמנות</h1>
        <div role="tablist" aria-label="תצוגת הזמנות" className="flex gap-1 rounded-lg border border-brand-border bg-brand-bg-elevated p-1">
          {TABS.map((tab) => (
            <a
              key={tab.view}
              href={tab.path}
              role="tab"
              aria-selected={route.view === tab.view}
              onClick={(event) => {
                event.preventDefault();
                navigateAdmin(tab.path);
              }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold ${route.view === tab.view ? "bg-brand-gold text-brand-bg" : "text-brand-text-muted hover:text-brand-text"}`}
            >
              {tab.label}
            </a>
          ))}
        </div>
      </div>
      {route.view === "history" ? <OrdersHistoryPage client={client} role={role} /> : <OrdersBoardPage client={client} role={role} />}
    </div>
  );
}
