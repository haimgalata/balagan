import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { navigateAdmin } from "@/admin/adminPath";
import { loadCostOverview } from "@/admin/costs/costsApi";
import { COSTS_PATH } from "@/admin/costs/costsRoute";
import { costWithVat, formatShekels, type CostOverview, type CostRow } from "@/admin/costs/costModel";
import { ProfitText } from "@/admin/costs/costsUi";

/** Read-only "cost · net profit · supplier" line in the product edit panel (by the SAVED price). Costs are edited only on the costs screen. */
export function ProductCostNote({ client, productId }: { client: SupabaseClient; productId: string }) {
  const [data, setData] = useState<{ overview: CostOverview; row: CostRow } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadCostOverview(client).then((r) => {
      if (cancelled || !r.ok) return;
      const row = r.data.rows.find((x) => x.id === productId);
      setData(row ? { overview: r.data, row } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [client, productId]);

  if (!data) return null;
  const { overview, row } = data;
  const supplier = overview.suppliers.find((s) => s.id === row.supplierId)?.name ?? "ללא ספק";
  return (
    <div className="rounded-lg border border-brand-border bg-brand-bg p-3 text-sm" data-testid="product-cost-note">
      <p className="text-brand-text">
        {row.costExVat === null ? "אין עלות" : `עלות כולל מע"מ ${formatShekels(costWithVat(row.costExVat, overview.vatPercent))}`} · רווח נקי <ProfitText row={row} overview={overview} /> · {supplier}
      </p>
      <a
        href={COSTS_PATH}
        onClick={(e) => {
          e.preventDefault();
          navigateAdmin(COSTS_PATH);
        }}
        className="mt-1 inline-block text-xs text-brand-gold underline-offset-2 hover:underline"
      >
        לעריכת העלות במסך עלויות ורווח
      </a>
    </div>
  );
}
