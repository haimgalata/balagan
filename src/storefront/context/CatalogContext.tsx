import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Product } from "@/storefront/types";
import { fallbackCatalog } from "@/storefront/data/fallbackCatalog";
import { fetchCatalog, getCatalogConfig, parseRpcCatalog, type RpcCatalog } from "@/storefront/lib/catalogApi";
import { mapCatalog, type MappedCatalog } from "@/storefront/lib/catalogMapper";

const CACHE_KEY = "balagan_catalog_v1";
const config = getCatalogConfig();

/** "loading" only happens on a first-ever visit (no cache yet) while the live catalog is being fetched. */
export type CatalogStatus = "loading" | "ready";
/** Where the data currently shown came from. */
export type CatalogOrigin = "static" | "cache" | "live";

interface CatalogState extends MappedCatalog {
  status: CatalogStatus;
  origin: CatalogOrigin;
}

interface CatalogContextValue extends CatalogState {
  /** Products of a category slug, in storefront display order. */
  getProductsByCategory: (categorySlug: string) => Product[];
  /**
   * Forces a fresh fetch from the database, bypassing the stale-while-revalidate cache, and updates state
   * immediately if the result differs from what's shown. Used by checkout to make sure prices/availability
   * are current right before the customer submits their details — see `src/checkout/useCheckoutValidation.ts`.
   * A no-op that resolves `true` in static mode (nothing to refresh); resolves `false` on network/shape failure.
   */
  refresh: () => Promise<boolean>;
}

const CatalogContext = createContext<CatalogContextValue | undefined>(undefined);

// ---------------------------------------------------------------- last-good cache
function readCache(): RpcCatalog | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    return parseRpcCatalog((JSON.parse(raw) as { data?: unknown } | null)?.data);
  } catch {
    return null; // unavailable storage / corrupted JSON => behave as if there is no cache
  }
}

function writeCache(catalog: RpcCatalog): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), data: catalog }));
  } catch {
    // storage full / private mode — the cache is only an optimisation
  }
}

/**
 * Offline fallback: a literal snapshot in the database's own shape (src/storefront/data/fallbackCatalog.ts), run
 * through the SAME mapper as live data — one code path, and no pricing rule anywhere in the app.
 */
const STATIC_CATALOG: MappedCatalog = mapCatalog(fallbackCatalog, config.supabaseUrl);

function initialState(): { state: CatalogState; shownJson: string | null } {
  if (config.source === "static") {
    return { state: { status: "ready", origin: "static", ...STATIC_CATALOG }, shownJson: null };
  }
  const cached = readCache();
  if (cached) {
    return {
      state: { status: "ready", origin: "cache", ...mapCatalog(cached, config.supabaseUrl) },
      shownJson: JSON.stringify(cached),
    };
  }
  return { state: { status: "loading", origin: "live", categories: [], products: [] }, shownJson: null };
}

/**
 * Single source of the storefront's catalog.
 *
 *  - `VITE_CATALOG_SOURCE=static` (or no Supabase env): the bundled fallback catalog.
 *  - Otherwise: show the last successfully fetched catalog INSTANTLY if there is one
 *    (stale-while-revalidate), fetch the live catalog in the background and swap it in.
 *  - First-ever visit (no cache): status is "loading" until the fetch finishes.
 *  - Fetch fails: keep whatever is showing; with nothing to show, fall back to the bundled
 *    catalog so the shop still works. A failed/slow network never affects the cart.
 */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(initialState);
  const [state, setState] = useState<CatalogState>(initial.state);
  const shownJson = useRef<string | null>(initial.shownJson);

  useEffect(() => {
    if (config.source !== "supabase") return;
    let cancelled = false;

    fetchCatalog(config)
      .then((live) => {
        if (cancelled) return;
        writeCache(live);
        const json = JSON.stringify(live);
        if (json === shownJson.current) return; // identical to what is already on screen — no re-render
        shownJson.current = json;
        setState({ status: "ready", origin: "live", ...mapCatalog(live, config.supabaseUrl) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn("[catalog] live catalog unavailable:", error);
        setState((current) =>
          current.status === "loading" ? { status: "ready", origin: "static", ...STATIC_CATALOG } : current
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (config.source !== "supabase") return true; // static/offline mode has nothing to refresh
    try {
      const live = await fetchCatalog(config);
      writeCache(live);
      const json = JSON.stringify(live);
      if (json !== shownJson.current) {
        shownJson.current = json;
        setState({ status: "ready", origin: "live", ...mapCatalog(live, config.supabaseUrl) });
      }
      return true;
    } catch (error) {
      console.warn("[catalog] on-demand refresh failed:", error);
      return false;
    }
  }, []);

  const value = useMemo<CatalogContextValue>(() => {
    const byCategory = new Map<string, Product[]>();
    for (const product of state.products) {
      const list = byCategory.get(product.category);
      if (list) list.push(product);
      else byCategory.set(product.category, [product]);
    }
    return { ...state, getProductsByCategory: (slug: string) => byCategory.get(slug) ?? [], refresh };
  }, [state, refresh]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used within a CatalogProvider");
  return ctx;
}
