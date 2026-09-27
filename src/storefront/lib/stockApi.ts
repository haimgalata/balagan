/**
 * Asks the database whether PROPOSED cart quantities (in base units) still fit each product's shared stock
 * (see supabase/migrations/0007_stock_availability.sql and src/context/CartContext.tsx). One plain `fetch`,
 * same pattern as catalogApi.ts (no client library, anon key only) — this file must stay free of
 * `@supabase/supabase-js` so the customer bundle does too.
 *
 * The request never sends the actual stock number (the caller sends only the TOTAL it wants to reach), and
 * the response never contains one either — just a yes/no per product. This is a UX safeguard, not a
 * reservation: it doesn't lock or deduct anything, and can't guarantee stock is still there a moment later.
 */
import type { CatalogConfig } from "@/storefront/lib/catalogApi";

export interface StockCheckItem {
  productId: string;
  /** The PROPOSED total for this product across all its cart lines (units + packages, in base units) — never the raw stock count. */
  baseUnits: number;
}
export interface StockCheckResult {
  productId: string;
  available: boolean;
}

const REQUEST_TIMEOUT_MS = 8000;

/** Throws on any network/shape problem — the caller decides how to fail (CartContext fails CLOSED: no add without a confirmed "yes"). */
export async function checkStockAvailability(config: CatalogConfig, items: StockCheckItem[]): Promise<StockCheckResult[]> {
  if (items.length === 0) return [];
  // Static/offline mode has no live database to ask; nothing is tracked there.
  if (config.source !== "supabase") return items.map((item) => ({ productId: item.productId, available: true }));

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/check_stock_availability`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        // legacy anon keys are JWTs and go in Authorization too; new-style publishable keys are not JWTs
        ...(config.anonKey.startsWith("eyJ") ? { Authorization: `Bearer ${config.anonKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_items: items.map((item) => ({ product_id: item.productId, base_units: item.baseUnits })) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`stock availability check failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("stock availability response has an unexpected shape");
    return body.map((row): StockCheckResult => {
      if (typeof row !== "object" || row === null) throw new Error("stock availability response has an unexpected shape");
      const { product_id, available } = row as Record<string, unknown>;
      if (typeof product_id !== "string" || typeof available !== "boolean") throw new Error("stock availability response has an unexpected shape");
      return { productId: product_id, available };
    });
  } finally {
    window.clearTimeout(timer);
  }
}
