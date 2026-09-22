import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ProductsListTab } from "@/admin/products/ProductsListTab";
import { ProductsOrderingTab } from "@/admin/products/ProductsOrderingTab";
import { useCategoryOptions } from "@/admin/products/useCategoryOptions";

const TABS = [
  { key: "list", label: "רשימת מוצרים" },
  { key: "order", label: "סדר תצוגה" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/**
 * Manage the shop's products: one tab to find/add/edit/hide/delete (search + filters across the whole
 * catalog, 50 per page), a SEPARATE tab to change storefront display order within one category/subcategory
 * group at a time (see ProductsOrderingTab for why a flat filtered list is the wrong place for up/down).
 */
export function ProductsPage({ client }: { client: SupabaseClient }) {
  const [tab, setTab] = useState<Tab>("list");
  const { data, status, reload } = useCategoryOptions(client);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-brand-text">מוצרים</h1>
      </div>

      <div role="tablist" aria-label="מוצרים" className="mb-4 flex gap-1 border-b border-brand-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-gold ${
              tab === t.key ? "border-brand-gold text-brand-gold" : "border-transparent text-brand-text-muted hover:text-brand-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {status === "loading" && !data ? (
        <div role="status" className="flex items-center justify-center gap-2 py-16 text-brand-text-muted">
          <Loader2 size={22} className="animate-spin text-brand-gold" aria-hidden="true" />
          טוען…
        </div>
      ) : status === "error" || !data ? (
        <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center">
          <p role="alert" className="mb-4 text-brand-danger">
            לא ניתן לטעון את הקטגוריות כרגע.
          </p>
          <Button onClick={reload}>נסו שוב</Button>
        </div>
      ) : tab === "list" ? (
        <ProductsListTab client={client} categories={data.categories} subcategories={data.subcategories} />
      ) : (
        <ProductsOrderingTab client={client} categories={data.categories} subcategories={data.subcategories} />
      )}
    </div>
  );
}
