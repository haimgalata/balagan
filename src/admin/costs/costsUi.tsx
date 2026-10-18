import { formatPercent, formatShekels, marginPercent, marginTone, netProfit, type CostOverview, type CostRow, type MarginTone } from "@/admin/costs/costModel";

export const TONE_CLASS: Record<MarginTone, string> = {
  good: "text-brand-success",
  low: "text-brand-gold",
  loss: "text-brand-danger",
  none: "text-brand-text-muted",
};

/** Net profit: "₪2.13 · 6%", coloured by the low-margin threshold. */
export function ProfitText({ row, overview }: { row: Pick<CostRow, "salePrice" | "costExVat">; overview: Pick<CostOverview, "vatPercent" | "lowMarginPercent"> }) {
  if (row.costExVat === null) return <span className="text-brand-text-muted">אין עלות</span>;
  const pct = marginPercent(row.salePrice, row.costExVat, overview.vatPercent);
  const tone = marginTone(pct, overview.lowMarginPercent);
  return (
    <span dir="ltr" className={`inline-block font-semibold ${TONE_CLASS[tone]}`} data-tone={tone}>
      {formatShekels(netProfit(row.salePrice, row.costExVat, overview.vatPercent))}
      {pct !== null && <> · {formatPercent(pct)}</>}
    </span>
  );
}
