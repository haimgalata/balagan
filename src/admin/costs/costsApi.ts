import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminError as BaseAdminError, RawApiError } from "@/admin/shared/apiError";
import { parseCostOverview, type CostOverview } from "@/admin/costs/costModel";

/**
 * The owner's costs data (supabase/migrations/0016_costs.sql). Owner only: staff, customers and anonymous visitors get
 * nothing from these tables or functions. Every function resolves — it never throws.
 */
type Kind = "permission" | "setup-needed" | "duplicate-barcode" | "blocked-barcode" | "invalid" | "network" | "unknown";
export type CostsError = BaseAdminError<Kind>;
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: CostsError };

const MESSAGES: Record<Kind, string> = {
  permission: "אין הרשאה. המסך הזה זמין לבעלים בלבד. ייתכן שההתחברות פגה — התנתקו והתחברו מחדש.",
  "setup-needed": "חסר עדכון במסד הנתונים: יש להריץ את הקובץ supabase/migrations/0016_costs.sql ב-SQL Editor של Supabase ואז לרענן את העמוד.",
  "duplicate-barcode": "הברקוד הזה כבר שייך למוצר אחר.",
  "blocked-barcode": "הברקוד הזה סומן כברקוד של פקט ולא יישמר.",
  invalid: "אחד הערכים לא תקין. בדקו ונסו שוב.",
  network: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
  unknown: "הפעולה נכשלה. נסו שוב.",
};

export function describeCostsError(error: RawApiError): CostsError {
  const code = error.code ?? "";
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  const kind: Kind =
    /BARCODE_BLOCKED/.test(text) ? "blocked-barcode"
    : code === "23505" || /products_barcode_key|duplicate key/i.test(text) ? "duplicate-barcode"
    : code === "42501" || /NOT_AUTHORIZED|permission denied|row-level security/i.test(text) ? "permission"
    : code === "PGRST202" || code === "PGRST205" || code === "42P01" || code === "42703" || /could not find the (function|table)|does not exist|schema cache/i.test(text) ? "setup-needed"
    : code === "23514" || code === "22P02" || /INVALID_COST|check constraint/i.test(text) ? "invalid"
    : code === "" && /fetch|network|failed to|load failed/i.test(text) ? "network"
    : "unknown";
  return { kind, message: MESSAGES[kind] };
}

const fail = (e: RawApiError): { ok: false; error: CostsError } => ({ ok: false, error: describeCostsError(e) });
const unexpected = (e: unknown) => fail({ code: "", message: e instanceof Error ? e.message : String(e) });

export async function loadCostOverview(client: SupabaseClient): Promise<ApiResult<CostOverview>> {
  try {
    const { data, error } = await client.rpc("admin_cost_overview");
    if (error) return fail(error);
    const parsed = parseCostOverview(data);
    return parsed ? { ok: true, data: parsed } : fail({ code: "", message: "unexpected response" });
  } catch (e) {
    return unexpected(e);
  }
}

export interface CostHistoryRow {
  id: number;
  supplierId: string | null;
  costExVat: number;
  source: "invoice" | "manual";
  invoiceNumber: string | null;
  invoiceDate: string | null;
  createdAt: string;
}

export async function loadCostHistory(client: SupabaseClient, productId: string): Promise<ApiResult<CostHistoryRow[]>> {
  try {
    const { data, error } = await client
      .from("cost_history")
      .select("id,supplier_id,unit_cost_ex_vat,source,invoice_number,invoice_date,created_at")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50);
    if (error) return fail(error);
    return {
      ok: true,
      data: (data ?? []).map((r: Record<string, unknown>) => ({
        id: Number(r.id),
        supplierId: (r.supplier_id as string | null) ?? null,
        costExVat: Number(r.unit_cost_ex_vat),
        source: r.source === "invoice" ? "invoice" : "manual",
        invoiceNumber: (r.invoice_number as string | null) ?? null,
        invoiceDate: (r.invoice_date as string | null) ?? null,
        createdAt: String(r.created_at),
      })),
    };
  } catch (e) {
    return unexpected(e);
  }
}

/** Supplier and/or a manual cost (before VAT). `costExVat` null = keep the current cost. Always writes the history. */
export async function setProductCost(client: SupabaseClient, productId: string, supplierId: string | null, costExVat: number | null): Promise<ApiResult<null>> {
  try {
    const { error } = await client.rpc("admin_set_product_cost", { p_product_id: productId, p_supplier_id: supplierId, p_cost_ex_vat: costExVat });
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

export async function clearReviewNote(client: SupabaseClient, productId: string): Promise<ApiResult<null>> {
  try {
    const { error } = await client.from("products").update({ review_note: null }).eq("id", productId);
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

// ---- barcodes (single packs only) ------------------------------------------------------------------------
export interface BarcodeProduct {
  id: string;
  name: string;
  salePrice: number;
  imagePath: string | null;
  barcode: string | null;
  isVisible: boolean;
}

const PRODUCT_COLS = "id,name_he,unit_price,unit_sale_enabled,unit_sale_price,image_path,barcode,is_visible";
const toProduct = (r: Record<string, unknown>): BarcodeProduct => {
  const regular = Number(r.unit_price);
  const sale = r.unit_sale_enabled && r.unit_sale_price !== null && Number(r.unit_sale_price) < regular ? Number(r.unit_sale_price) : regular;
  return { id: String(r.id), name: String(r.name_he), salePrice: sale, imagePath: (r.image_path as string | null) ?? null, barcode: (r.barcode as string | null) ?? null, isVisible: r.is_visible === true };
};

export type BarcodeLookup = { kind: "product"; product: BarcodeProduct } | { kind: "blocked"; note: string | null } | { kind: "unknown" };

export async function lookupBarcode(client: SupabaseClient, barcode: string): Promise<ApiResult<BarcodeLookup>> {
  try {
    const [product, blocked] = await Promise.all([
      client.from("products").select(PRODUCT_COLS).eq("barcode", barcode).maybeSingle(),
      client.from("barcode_blocklist").select("note").eq("barcode", barcode).maybeSingle(),
    ]);
    if (product.error) return fail(product.error);
    if (blocked.error) return fail(blocked.error);
    if (product.data) return { ok: true, data: { kind: "product", product: toProduct(product.data) } };
    if (blocked.data) return { ok: true, data: { kind: "blocked", note: (blocked.data.note as string | null) ?? null } };
    return { ok: true, data: { kind: "unknown" } };
  } catch (e) {
    return unexpected(e);
  }
}

/** Products to pick from for an unknown barcode: by name, cigarettes first (or every category). */
export async function searchProducts(client: SupabaseClient, term: string, cigarettesOnly: boolean): Promise<ApiResult<BarcodeProduct[]>> {
  try {
    const safe = term.replace(/[%,()*]/g, " ").trim();
    let query = client.from("products").select(`${PRODUCT_COLS},categories!inner(slug)`).order("name_he").limit(30);
    if (safe) query = query.ilike("name_he", `%${safe}%`);
    if (cigarettesOnly) query = query.eq("categories.slug", "cigarettes");
    const { data, error } = await query;
    if (error) return fail(error);
    return { ok: true, data: (data ?? []).map((r) => toProduct(r as Record<string, unknown>)) };
  } catch (e) {
    return unexpected(e);
  }
}

export async function attachBarcode(client: SupabaseClient, productId: string, barcode: string): Promise<ApiResult<null>> {
  try {
    const { error } = await client.from("products").update({ barcode }).eq("id", productId);
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

/** Moves a barcode from one product to another (the owner confirmed it was on the wrong product). */
export async function moveBarcode(client: SupabaseClient, fromProductId: string, toProductId: string, barcode: string): Promise<ApiResult<null>> {
  const cleared = await (async () => {
    try {
      const { error } = await client.from("products").update({ barcode: null }).eq("id", fromProductId);
      return error ? fail(error) : ({ ok: true, data: null } as const);
    } catch (e) {
      return unexpected(e);
    }
  })();
  if (!cleared.ok) return cleared;
  return attachBarcode(client, toProductId, barcode);
}

export async function blockBarcode(client: SupabaseClient, barcode: string, note: string): Promise<ApiResult<null>> {
  try {
    const { error } = await client.from("barcode_blocklist").insert({ barcode, note });
    return error && error.code !== "23505" ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

export async function findBarcodeOwner(client: SupabaseClient, barcode: string): Promise<BarcodeProduct | null> {
  try {
    const { data } = await client.from("products").select(PRODUCT_COLS).eq("barcode", barcode).maybeSingle();
    return data ? toProduct(data) : null;
  } catch {
    return null;
  }
}

export interface CigaretteGroup {
  id: string;
  name: string;
}

/** Cigarette subcategories, for creating a product that was not on the site yet. */
export async function loadCigaretteGroups(client: SupabaseClient): Promise<ApiResult<{ categoryId: string; groups: CigaretteGroup[] }>> {
  try {
    const { data, error } = await client.from("categories").select("id,subcategories(id,name_he,sort_order)").eq("slug", "cigarettes").single();
    if (error) return fail(error);
    const groups = ((data.subcategories ?? []) as { id: string; name_he: string; sort_order: number }[])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({ id: s.id, name: s.name_he }));
    return { ok: true, data: { categoryId: String(data.id), groups } };
  } catch (e) {
    return unexpected(e);
  }
}

/** A cigarette product created while scanning: with a price it is visible; without one it stays hidden and flagged. */
export async function createScannedProduct(
  client: SupabaseClient,
  input: { categoryId: string; subcategoryId: string; name: string; price: number | null; barcode: string }
): Promise<ApiResult<{ id: string }>> {
  try {
    const { data, error } = await client
      .from("products")
      .insert({
        category_id: input.categoryId,
        subcategory_id: input.subcategoryId,
        name_he: input.name,
        unit_price: input.price ?? 0,
        is_visible: input.price !== null,
        review_note: input.price === null ? "נוצר בסריקה, חסר מחיר" : "נוצר בסריקה",
        barcode: input.barcode,
        sort_order: 30000,
      })
      .select("id")
      .single();
    if (error) return fail(error);
    return { ok: true, data: { id: String(data.id) } };
  } catch (e) {
    return unexpected(e);
  }
}
