import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { fallbackBusinessSettings } from "@/storefront/data/fallbackBusinessSettings";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { fetchBusinessSettings, parseRpcBusinessSettings, type RpcBusinessSettings } from "@/storefront/lib/businessSettingsApi";

const CACHE_KEY = "balagan_business_settings_v1";
const config = getCatalogConfig();

/** Where the settings currently shown came from. */
export type BusinessSettingsOrigin = "static" | "cache" | "live";

interface BusinessSettingsState {
  origin: BusinessSettingsOrigin;
  settings: RpcBusinessSettings;
}

const BusinessSettingsContext = createContext<BusinessSettingsState | undefined>(undefined);

// ---------------------------------------------------------------- last-good cache
function readCache(): RpcBusinessSettings | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    return parseRpcBusinessSettings((JSON.parse(raw) as { data?: unknown } | null)?.data);
  } catch {
    return null; // unavailable storage / corrupted JSON => behave as if there is no cache
  }
}

function writeCache(settings: RpcBusinessSettings): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), data: settings }));
  } catch {
    // storage full / private mode — the cache is only an optimisation
  }
}

function initialState(): { state: BusinessSettingsState; shownJson: string | null } {
  if (config.source === "static") return { state: { origin: "static", settings: fallbackBusinessSettings }, shownJson: null };
  const cached = readCache();
  if (cached) return { state: { origin: "cache", settings: cached }, shownJson: JSON.stringify(cached) };
  // Unlike the catalog, there's no meaningful "loading" state for a pill + a banner — show today's
  // placeholder hours immediately, and swap to the live schedule in the background once fetched.
  return { state: { origin: "static", settings: fallbackBusinessSettings }, shownJson: null };
}

/**
 * Single source of the storefront's business settings (physical-store hours, online-order hours, minimum
 * order, delivery fee, manual pause) — see supabase/migrations/0008_business_settings.sql /
 * src/lib/businessSettingsApi.ts.
 *
 *  - `VITE_CATALOG_SOURCE=static` (or no Supabase env): the bundled fallback.
 *  - Otherwise: show the last successfully fetched settings INSTANTLY if there is one (stale-while-
 *    revalidate), fetch the live settings in the background and swap them in.
 *  - Fetch fails: keep whatever is showing (cache or fallback) — a failed/slow network never breaks the
 *    header pill or the info banner.
 */
export function BusinessSettingsProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(initialState);
  const [state, setState] = useState<BusinessSettingsState>(initial.state);
  const shownJson = useRef<string | null>(initial.shownJson);

  useEffect(() => {
    if (config.source !== "supabase") return;
    let cancelled = false;

    fetchBusinessSettings(config)
      .then((live) => {
        if (cancelled) return;
        writeCache(live);
        const json = JSON.stringify(live);
        if (json === shownJson.current) return; // identical to what is already on screen — no re-render
        shownJson.current = json;
        setState({ origin: "live", settings: live });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn("[business-settings] live settings unavailable:", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return <BusinessSettingsContext.Provider value={state}>{children}</BusinessSettingsContext.Provider>;
}

export function useBusinessSettings(): BusinessSettingsState {
  const ctx = useContext(BusinessSettingsContext);
  if (!ctx) throw new Error("useBusinessSettings must be used within a BusinessSettingsProvider");
  return ctx;
}
