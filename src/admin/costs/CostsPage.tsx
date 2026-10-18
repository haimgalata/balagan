import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2, ScanLine } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { navigateAdmin } from "@/admin/adminPath";
import { loadCostOverview } from "@/admin/costs/costsApi";
import { CostDetailDrawer } from "@/admin/costs/CostDetailDrawer";
import { SCAN_PATH } from "@/admin/costs/costsRoute";
import { costChange, costWithVat, formatPercent, formatShekels, marginPercent, marginTone, summarize, type CostOverview } from "@/admin/costs/costModel";
import { ProfitText } from "@/admin/costs/costsUi";
import { formatDateTime } from "@/admin/orders/orderModel";
import { MobileLabel, RT_BODY, RT_CELL, RT_HEAD, RT_ROW, RT_TABLE } from "@/admin/shared/responsiveTable";

const NO_SUPPLIER = "none";

/** The owner's costs and net-profit screen (cigarettes + anything else that has a cost). Owner only. */
export function CostsPage({ client }: { client: SupabaseClient }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: CostOverview }>({ status: "loading" });
  const [tab, setTab] = useState<string>("philip-morris");
  const [lowOnly, setLowOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await loadCostOverview(client);
    setState(r.ok ? { status: "ready", data: r.data } : { status: "error", message: r.error.message });
  }, [client]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const overview = state.status === "ready" ? state.data : null;
  const tabs = useMemo(() => [...(overview?.suppliers ?? []), { id: NO_SUPPLIER, name: "ללא ספק" }], [overview]);
  const inTab = useMemo(
    () => (overview?.rows ?? []).filter((r) => (tab === NO_SUPPLIER ? r.supplierId === null : r.supplierId === tab)),
    [overview, tab]
  );
  const shown = useMemo(() => {
    if (!overview) return [];
    const term = search.trim();
    return inTab.filter((r) => {
      if (term && !r.name.includes(term)) return false;
      if (!lowOnly) return true;
      const tone = r.costExVat === null ? "none" : marginTone(marginPercent(r.salePrice, r.costExVat, overview.vatPercent), overview.lowMarginPercent);
      return tone === "low" || tone === "loss";
    });
  }, [overview, inTab, search, lowOnly]);

  const openRow = overview?.rows.find((r) => r.id === openId) ?? null;

  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-brand-text-muted">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" /> טוען עלויות…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
        <span>{state.message}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
          נסו שוב
        </Button>
      </div>
    );
  }
  const data = state.data;
  const counts = summarize(inTab);

  return (
    <section aria-labelledby="costs-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 id="costs-title" className="text-xl font-bold text-brand-text">עלויות ורווח</h1>
          <p className="mt-1 text-sm text-brand-text-muted">
            רווח נקי לחפיסה = מחיר מכירה ÷ {1 + data.vatPercent / 100} פחות העלות לפני מע"מ. רווח נמוך: מתחת ל-{formatPercent(data.lowMarginPercent)}.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={() => navigateAdmin(SCAN_PATH)}>
          <ScanLine size={16} aria-hidden="true" />
          סריקת ברקודים
        </Button>
      </div>

      <div role="tablist" aria-label="ספקים" className="mb-3 flex gap-1 overflow-x-auto border-b border-brand-border [scrollbar-width:none]">
        {tabs.map((t) => {
          const n = data.rows.filter((r) => (t.id === NO_SUPPLIER ? r.supplierId === null : r.supplierId === t.id)).length;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? "border-brand-gold text-brand-gold" : "border-transparent text-brand-text-muted hover:text-brand-text"}`}
            >
              {t.name} <span className="text-xs">({n})</span>
            </button>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span data-testid="costs-count-cost" className="rounded-full border border-brand-border px-3 py-1">
          {counts.withCost} מתוך {counts.total} עם עלות
        </span>
        <span data-testid="costs-count-barcode" className="rounded-full border border-brand-border px-3 py-1">
          {counts.withBarcode} מתוך {counts.total} עם ברקוד
        </span>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="accent-brand-gold" />
          רק רווח נמוך
        </label>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש לפי שם"
          aria-label="חיפוש לפי שם"
          className="min-w-0 flex-1 rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text outline-none focus-visible:border-brand-gold sm:max-w-xs"
        />
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center text-brand-text-muted">אין מוצרים להצגה.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-brand-border bg-brand-bg-elevated">
          <table className={RT_TABLE} data-testid="costs-table">
            <thead className={RT_HEAD}>
              <tr>
                <th className="px-3 py-2 text-start">מוצר</th>
                <th className="px-3 py-2 text-start">מחיר מכירה</th>
                <th className="px-3 py-2 text-start">עלות כולל מע"מ</th>
                <th className="px-3 py-2 text-start">רווח נקי</th>
                <th className="px-3 py-2 text-start">עודכן</th>
                <th className="px-3 py-2 text-start">ברקוד</th>
              </tr>
            </thead>
            <tbody className={RT_BODY}>
              {shown.map((row) => {
                const change = costChange(row.costExVat, row.previousCostExVat);
                return (
                  <tr key={row.id} className={`${RT_ROW} cursor-pointer hover:bg-brand-bg`} onClick={() => setOpenId(row.id)} data-testid={`cost-row-${row.id}`}>
                    <td className={RT_CELL}>
                      <MobileLabel>מוצר</MobileLabel>
                      <button type="button" className="text-start font-medium text-brand-text underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(row.id); }}>
                        {row.name}
                      </button>
                      {!row.isVisible && <span className="ms-2 text-xs text-brand-text-muted">(מוסתר)</span>}
                      {row.reviewNote && <span className="ms-2 rounded border border-brand-gold/60 px-1.5 py-0.5 text-[11px] text-brand-gold">{row.reviewNote}</span>}
                    </td>
                    <td className={RT_CELL}>
                      <MobileLabel>מחיר מכירה</MobileLabel>
                      {formatShekels(row.salePrice)}
                    </td>
                    <td className={RT_CELL}>
                      <MobileLabel>עלות כולל מע"מ</MobileLabel>
                      {row.costExVat === null ? "—" : formatShekels(costWithVat(row.costExVat, data.vatPercent))}
                      {change !== null && (
                        <span className={`ms-1 text-xs ${change > 0 ? "text-brand-danger" : "text-brand-success"}`} title="שינוי מול העלות הקודמת (לפני מע״מ)">
                          {change > 0 ? "↑" : "↓"}
                          {formatShekels(Math.abs(change))}
                        </span>
                      )}
                    </td>
                    <td className={RT_CELL}>
                      <MobileLabel>רווח נקי</MobileLabel>
                      <ProfitText row={row} overview={data} />
                    </td>
                    <td className={RT_CELL}>
                      <MobileLabel>עודכן</MobileLabel>
                      {row.costUpdatedAt ? formatDateTime(row.costUpdatedAt) : "—"}
                    </td>
                    <td className={RT_CELL}>
                      <MobileLabel>ברקוד</MobileLabel>
                      {row.hasBarcode ? <span className="text-brand-success" aria-label="יש ברקוד">✓</span> : <span className="text-brand-text-muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CostDetailDrawer client={client} row={openRow} overview={data} onClose={() => setOpenId(null)} onChanged={() => void reload()} />
    </section>
  );
}
