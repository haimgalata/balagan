/**
 * Reads the public storefront catalog from Supabase.
 *
 * The storefront has NO access to the database tables — anonymous visitors can
 * only call the whitelisted RPC `get_storefront_catalog()` (see
 * supabase/migrations/0004_rpc.sql). One plain `fetch`, no client library, and
 * only the public anon key (never the service_role key).
 *
 * Whatever comes back is validated structurally before it can reach the UI or the
 * cache: a malformed/partial response is rejected (the caller then falls back)
 * instead of half-rendering.
 */

export interface RpcOption {
  price: number;
  sale_price: number | null;
  in_stock: boolean;
}
export interface RpcPackage extends RpcOption {
  label: string;
  unit_count: number;
}
export interface RpcProduct {
  id: string;
  category: string;
  subcategory: string | null;
  name_he: string;
  name_en: string | null;
  brand: string | null;
  description: string | null;
  image_path: string | null;
  unit: RpcOption;
  package: RpcPackage | null;
}
export interface RpcSubcategory {
  id: string;
  slug: string;
  name_he: string;
  name_en: string | null;
}
export interface RpcCategory {
  id: string;
  slug: string;
  name_he: string;
  name_en: string | null;
  subcategories: RpcSubcategory[];
}
export interface RpcCatalog {
  categories: RpcCategory[];
  products: RpcProduct[];
}

export type CatalogSource = "supabase" | "static";

export interface CatalogConfig {
  source: CatalogSource;
  supabaseUrl: string;
  anonKey: string;
}

/** Resolved once from the Vite env. "supabase" only when URL + key are both present. */
export function getCatalogConfig(): CatalogConfig {
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  const requested = import.meta.env.VITE_CATALOG_SOURCE;
  const canUseSupabase = supabaseUrl !== "" && anonKey !== "";

  if (requested === "supabase" && !canUseSupabase && import.meta.env.DEV) {
    console.warn("[catalog] VITE_CATALOG_SOURCE=supabase but VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing — using the bundled catalog.");
  }
  const source: CatalogSource = requested === "static" || !canUseSupabase ? "static" : "supabase";
  return { source, supabaseUrl, anonKey };
}

// ---------------------------------------------------------------- validation
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isOption(v: unknown): v is RpcOption {
  return isObj(v) && isNum(v.price) && (v.sale_price === null || isNum(v.sale_price)) && typeof v.in_stock === "boolean";
}
function isPackage(v: unknown): v is RpcPackage {
  return isOption(v) && isStr((v as unknown as Record<string, unknown>).label) && isNum((v as unknown as Record<string, unknown>).unit_count);
}
function isProduct(v: unknown): v is RpcProduct {
  return (
    isObj(v) &&
    isStr(v.id) && isStr(v.category) && isStrOrNull(v.subcategory) &&
    isStr(v.name_he) && isStrOrNull(v.name_en) && isStrOrNull(v.brand) &&
    isStrOrNull(v.description) && isStrOrNull(v.image_path) &&
    isOption(v.unit) && (v.package === null || isPackage(v.package))
  );
}
function isSubcategory(v: unknown): v is RpcSubcategory {
  return isObj(v) && isStr(v.id) && isStr(v.slug) && isStr(v.name_he) && isStrOrNull(v.name_en);
}
function isCategory(v: unknown): v is RpcCategory {
  return isObj(v) && isStr(v.id) && isStr(v.slug) && isStr(v.name_he) && isStrOrNull(v.name_en) &&
    Array.isArray(v.subcategories) && v.subcategories.every(isSubcategory);
}

/** Returns the catalog if (and only if) it has the exact expected shape, else null. */
export function parseRpcCatalog(value: unknown): RpcCatalog | null {
  if (!isObj(value) || !Array.isArray(value.categories) || !Array.isArray(value.products)) return null;
  if (!value.categories.every(isCategory) || !value.products.every(isProduct)) return null;
  return value as unknown as RpcCatalog;
}

// ---------------------------------------------------------------------- fetch
const REQUEST_TIMEOUT_MS = 8000;

export async function fetchCatalog(config: CatalogConfig): Promise<RpcCatalog> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_storefront_catalog`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        // legacy anon keys are JWTs and go in Authorization too; new-style publishable keys are not JWTs
        ...(config.anonKey.startsWith("eyJ") ? { Authorization: `Bearer ${config.anonKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`catalog request failed: HTTP ${response.status}`);
    const catalog = parseRpcCatalog(await response.json());
    if (!catalog) throw new Error("catalog response has an unexpected shape");
    return catalog;
  } finally {
    window.clearTimeout(timer);
  }
}
