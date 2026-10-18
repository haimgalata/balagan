/**
 * Purchase cost and NET profit per unit (pure, unit-tested — tests/admin/costs/costModel.unit.spec.ts).
 *
 * Costs are stored BEFORE VAT, exactly as the supplier invoice prints them. Sale prices include VAT. So:
 *   net profit = sale price / (1 + VAT) - cost before VAT        e.g. 42 / 1.18 - 33.46 = 2.13 ₪
 *   margin %   = net profit / (sale price / (1 + VAT))           e.g. 2.13 / 35.59 = 6%
 * The owner sees the cost INCLUDING VAT (what he really pays) beside it: 33.46 * 1.18 = 39.48 ₪.
 */
export interface CostSupplier {
  id: string;
  name: string;
}

export interface CostRow {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  isVisible: boolean;
  salePrice: number;
  hasBarcode: boolean;
  reviewNote: string | null;
  supplierId: string | null;
  costExVat: number | null;
  costSource: "invoice" | "manual" | null;
  costUpdatedAt: string | null;
  previousCostExVat: number | null;
}

export interface CostOverview {
  vatPercent: number;
  lowMarginPercent: number;
  suppliers: CostSupplier[];
  rows: CostRow[];
}

export type MarginTone = "good" | "low" | "loss" | "none";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const vatFactor = (vatPercent: number): number => 1 + vatPercent / 100;

/** What one unit really costs the store, VAT included. */
export function costWithVat(costExVat: number, vatPercent: number): number {
  return round2(costExVat * vatFactor(vatPercent));
}

/** The part of a VAT-inclusive sale price that belongs to the store. */
export function priceExVat(salePrice: number, vatPercent: number): number {
  return round2(salePrice / vatFactor(vatPercent));
}

/** Net profit per unit, in shekels. */
export function netProfit(salePrice: number, costExVat: number, vatPercent: number): number {
  return round2(salePrice / vatFactor(vatPercent) - costExVat);
}

/** Net profit as a share of the sale price before VAT, one decimal. Null when there is no sale price. */
export function marginPercent(salePrice: number, costExVat: number, vatPercent: number): number | null {
  const ex = salePrice / vatFactor(vatPercent);
  if (ex <= 0) return null;
  return Math.round(((ex - costExVat) / ex) * 1000) / 10;
}

export function marginTone(percent: number | null, lowMarginPercent: number): MarginTone {
  if (percent === null) return "none";
  if (percent < 0) return "loss";
  if (percent < lowMarginPercent) return "low";
  return "good";
}

/** Cost of ONE unit from an invoice line: the line price after its discount, divided by the units in it (carton = 10). */
export function unitCostFromLine(linePrice: number, discountPercent: number, unitsPerSupplierUnit: number): number {
  if (unitsPerSupplierUnit <= 0) throw new Error("unitsPerSupplierUnit must be positive");
  return round2((linePrice * (1 - discountPercent / 100)) / unitsPerSupplierUnit);
}

/** Change against the previous recorded cost (positive = the supplier raised it), or null when there is none. */
export function costChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  const diff = round2(current - previous);
  return diff === 0 ? null : diff;
}

export const formatShekels = (n: number): string => (n < 0 ? `-₪${Math.abs(n).toFixed(2)}` : `₪${n.toFixed(2)}`);
export const formatPercent = (p: number): string => `${Number.isInteger(p) ? p : p.toFixed(1)}%`;

export function summarize(rows: readonly CostRow[]): { total: number; withCost: number; withBarcode: number } {
  return {
    total: rows.length,
    withCost: rows.filter((r) => r.costExVat !== null).length,
    withBarcode: rows.filter((r) => r.hasBarcode).length,
  };
}

// ---- parsing the admin_cost_overview() answer (migration 0016) ----------------------------------------------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parseCostOverview(value: unknown): CostOverview | null {
  if (!isObj(value) || !Array.isArray(value.products) || !Array.isArray(value.suppliers)) return null;
  const rows: CostRow[] = [];
  for (const p of value.products) {
    if (!isObj(p) || typeof p.id !== "string" || typeof p.name !== "string") return null;
    const source = str(p.cost_source);
    rows.push({
      id: p.id,
      name: p.name,
      category: str(p.category) ?? "",
      subcategory: str(p.subcategory),
      isVisible: p.is_visible === true,
      salePrice: num(p.sale_price) ?? 0,
      hasBarcode: p.has_barcode === true,
      reviewNote: str(p.review_note),
      supplierId: str(p.supplier_id),
      costExVat: num(p.unit_cost_ex_vat),
      costSource: source === "invoice" || source === "manual" ? source : null,
      costUpdatedAt: str(p.cost_updated_at),
      previousCostExVat: num(p.previous_cost_ex_vat),
    });
  }
  const suppliers = value.suppliers.filter(isObj).map((s) => ({ id: String(s.id), name: String(s.name) }));
  return { vatPercent: num(value.vat_percent) ?? 18, lowMarginPercent: num(value.low_margin_percent) ?? 5, suppliers, rows };
}

/** A typed or scanned barcode, cleaned: spaces/dashes dropped. Null when it can't be a shop barcode (4–32 letters/digits). */
export function normalizeBarcode(raw: string): string | null {
  const clean = raw.replace(/[\s-]/g, "");
  return /^[0-9A-Za-z]{4,32}$/.test(clean) ? clean : null;
}

/** Cigarettes still without a barcode, grouped by subcategory (shelf by shelf), in the overview's order. */
export function missingBarcodes(rows: readonly CostRow[]): { group: string; names: { id: string; name: string }[] }[] {
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    if (r.category !== "cigarettes" || r.hasBarcode || !r.isVisible) continue;
    const key = r.subcategory ?? "אחר";
    groups.set(key, [...(groups.get(key) ?? []), { id: r.id, name: r.name }]);
  }
  return [...groups].map(([group, names]) => ({ group, names }));
}
