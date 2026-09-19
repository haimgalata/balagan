import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Product } from "@/types";
import { categories as staticCategories } from "@/data/categories";
import { products as staticProducts } from "@/data/products";
import { fetchCatalog, getCatalogConfig, parseRpcCatalog, type RpcCatalog } from "@/lib/catalogApi";
import { mapCatalog, type MappedCatalog } from "@/lib/catalogMapper";

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

const STATIC_CATALOG: MappedCatalog = { categories: staticCategories, products: staticProducts };

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
 *  - `VITE_CATALOG_SOURCE=static` (or no Supabase env): the bundled `src/data` files, as before.
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

  const value = useMemo<CatalogContextValue>(() => {
    const byCategory = new Map<string, Product[]>();
    for (const product of state.products) {
      const list = byCategory.get(product.category);
      if (list) list.push(product);
      else byCategory.set(product.category, [product]);
    }
    return { ...state, getProductsByCategory: (slug: string) => byCategory.get(slug) ?? [] };
  }, [state]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used within a CatalogProvider");
  return ctx;
}
