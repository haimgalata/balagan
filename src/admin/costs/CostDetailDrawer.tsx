import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { clearReviewNote, loadCostHistory, setProductCost, type CostHistoryRow } from "@/admin/costs/costsApi";
import {
  costWithVat, formatPercent, formatShekels, marginPercent, marginTone, netProfit, priceExVat,
  type CostOverview, type CostRow,
} from "@/admin/costs/costModel";
import { TONE_CLASS } from "@/admin/costs/costsUi";
import { formatDateTime } from "@/admin/orders/orderModel";

interface CostDetailDrawerProps {
  client: SupabaseClient;
  row: CostRow | null;
  overview: CostOverview;
  onClose: () => void;
  onChanged: () => void;
}

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text outline-none focus-visible:border-brand-gold disabled:opacity-50";

/** The calculation spelled out, exactly like the example the owner agreed to (42 ₪, cost 33.46 → 2.13 ₪ · 6%). */
function Breakdown({ row, overview }: { row: CostRow; overview: CostOverview }) {
  if (row.costExVat === null) {
    return <p className="text-sm text-brand-text-muted">עוד אין עלות למוצר הזה. הזינו אותה למטה (לפני מע"מ, כמו בחשבונית).</p>;
  }
  const vat = overview.vatPercent;
  const pct = marginPercent(row.salePrice, row.costExVat, vat);
  const tone = marginTone(pct, overview.lowMarginPercent);
  const line = (label: string, value: string, extra = "") => (
    <div className={`flex justify-between gap-3 py-1 ${extra}`}>
      <dt className="text-brand-text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className="rounded-lg border border-brand-border bg-brand-bg p-3 text-sm" data-testid="cost-breakdown">
      {line("מחיר מכירה (כולל מע\"מ)", formatShekels(row.salePrice))}
      {line(`בלי מע"מ (÷ ${1 + vat / 100})`, formatShekels(priceExVat(row.salePrice, vat)))}
      {line("עלות לפני מע\"מ", formatShekels(row.costExVat))}
      {line("עלות כולל מע\"מ", formatShekels(costWithVat(row.costExVat, vat)))}
      <div className="flex justify-between gap-3 border-t border-brand-border pt-2 font-semibold">
        <dt>רווח נקי לחפיסה</dt>
        <dd dir="ltr" className={TONE_CLASS[tone]}>
          {formatShekels(netProfit(row.salePrice, row.costExVat, vat))}
          {pct !== null && ` · ${formatPercent(pct)}`}
        </dd>
      </div>
    </dl>
  );
}

function Detail({ client, row, overview, onChanged }: Omit<CostDetailDrawerProps, "onClose" | "row"> & { row: CostRow }) {
  const [history, setHistory] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: CostHistoryRow[] }>({ status: "loading" });
  const [supplier, setSupplier] = useState(row.supplierId ?? "");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setSupplier(row.supplierId ?? "");
  }, [row.supplierId]);

  useEffect(() => {
    let cancelled = false;
    void loadCostHistory(client, row.id).then((r) => {
      if (!cancelled) setHistory(r.ok ? { status: "ready", data: r.data } : { status: "error", message: r.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [client, row.id, version]);

  const supplierName = (id: string | null) => overview.suppliers.find((s) => s.id === id)?.name ?? "—";
  const trimmed = cost.trim();
  const parsedCost = trimmed === "" ? null : Number(trimmed);
  const costInvalid = parsedCost !== null && (!Number.isFinite(parsedCost) || parsedCost < 0 || parsedCost > 100000);
  const changed = (supplier || null) !== row.supplierId || parsedCost !== null;

  const save = async () => {
    if (costInvalid || !changed) return;
    setBusy(true);
    setMessage(null);
    const r = await setProductCost(client, row.id, supplier || null, parsedCost === null ? null : Math.round(parsedCost * 100) / 100);
    setBusy(false);
    if (r.ok) {
      setCost("");
      setMessage({ ok: true, text: "נשמר." });
      setVersion((v) => v + 1);
      onChanged();
    } else setMessage({ ok: false, text: r.error.message });
  };

  const clearNote = async () => {
    setBusy(true);
    const r = await clearReviewNote(client, row.id);
    setBusy(false);
    if (r.ok) onChanged();
    else setMessage({ ok: false, text: r.error.message });
  };

  return (
    <div className="space-y-5 p-4">
      <div>
        <h3 className="text-lg font-bold text-brand-text">{row.name}</h3>
        <p className="text-sm text-brand-text-muted">
          {row.subcategory ? `${row.subcategory} · ` : ""}ספק: {supplierName(row.supplierId)}
          {!row.isVisible && " · מוסתר באתר"}
        </p>
        {row.reviewNote && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-brand-gold/60 px-3 py-2 text-sm text-brand-gold">
            <span>לבדיקה: {row.reviewNote}</span>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void clearNote()}>
              בדקתי, להסיר
            </Button>
          </div>
        )}
      </div>

      <Breakdown row={row} overview={overview} />

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-brand-text-muted">ספק</span>
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className={inputClasses} disabled={busy}>
            <option value="">ללא ספק</option>
            {overview.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-brand-text-muted">עלות חדשה לחפיסה — לפני מע"מ, כמו בחשבונית (פקט של 10: לחלק ב-10)</span>
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder={row.costExVat === null ? "למשל 33.46" : `היום: ${row.costExVat}`}
            className={inputClasses}
            disabled={busy}
            aria-invalid={costInvalid}
          />
          {parsedCost !== null && !costInvalid && (
            <span className="mt-1 block text-xs text-brand-text-muted">
              כולל מע"מ: {formatShekels(costWithVat(parsedCost, overview.vatPercent))} · רווח נקי: {formatShekels(netProfit(row.salePrice, parsedCost, overview.vatPercent))}
            </span>
          )}
          {costInvalid && <span className="mt-1 block text-xs text-brand-danger">מספר לא תקין</span>}
        </label>
        <Button type="submit" disabled={busy || costInvalid || !changed}>
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          שמירה
        </Button>
        {message && (
          <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-brand-success" : "text-brand-danger"}`}>
            {message.text}
          </p>
        )}
      </form>

      <div>
        <h4 className="mb-2 font-semibold text-brand-text">היסטוריית עלויות</h4>
        {history.status === "loading" && <Loader2 size={18} className="animate-spin text-brand-text-muted" aria-label="טוען" />}
        {history.status === "error" && <p className="text-sm text-brand-danger">{history.message}</p>}
        {history.status === "ready" &&
          (history.data.length === 0 ? (
            <p className="text-sm text-brand-text-muted">אין עדיין היסטוריה.</p>
          ) : (
            <ul className="divide-y divide-brand-border rounded-lg border border-brand-border text-sm" data-testid="cost-history">
              {history.data.map((h, i) => {
                const older = history.data[i + 1];
                const diff = older ? Math.round((h.costExVat - older.costExVat) * 100) / 100 : 0;
                return (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>
                      {formatShekels(h.costExVat)}
                      {diff !== 0 && (
                        <span className={`ms-1 text-xs ${diff > 0 ? "text-brand-danger" : "text-brand-success"}`}>
                          {diff > 0 ? "↑" : "↓"}
                          {formatShekels(Math.abs(diff))}
                        </span>
                      )}
                      <span className="ms-2 text-xs text-brand-text-muted">{supplierName(h.supplierId)}</span>
                    </span>
                    <span className="text-xs text-brand-text-muted">
                      {h.source === "invoice" ? `חשבונית ${h.invoiceNumber ?? ""}${h.invoiceDate ? ` · ${h.invoiceDate.split("-").reverse().join("/")}` : ""}` : `ידני · ${formatDateTime(h.createdAt)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          ))}
      </div>
    </div>
  );
}

export function CostDetailDrawer({ row, onClose, ...rest }: CostDetailDrawerProps) {
  return (
    <Drawer isOpen={row !== null} onClose={onClose} title="עלות ורווח" side="right" widthClassName="max-w-md">
      {row && <Detail key={row.id} row={row} {...rest} />}
    </Drawer>
  );
}
