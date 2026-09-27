import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_FILTERS, listProducts, type ApiResult, type ProductFilters, type ProductRow } from "@/admin/products/productsApi";
import type { AdminError } from "@/admin/products/productErrors";

export type Feedback = { kind: "success" | "error"; message: string };

/**
 * Data + mutations for the products LIST tab: search/filter/paginate (all in the database — see
 * productsApi.listProducts), then create/edit/hide/delete. Every mutation goes through `run`, which reloads
 * the current page afterwards — also after a failure — so what is on screen always matches what is stored.
 * Changing the search text or any filter resets to page 1 (a stale page number after narrowing the results
 * would silently show "no results" or the wrong rows).
 */
export function useProductManager(client: SupabaseClient) {
  const [filters, setFilters] = useState<ProductFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<AdminError | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const alive = useRef(true);

  const load = useCallback(
    async (keepScreen: boolean) => {
      const result = await listProducts(client, filters, page);
      if (!alive.current) return;
      if (result.ok) {
        setRows(result.data.rows);
        setTotal(result.data.total);
        setLoadError(null);
        setStatus("ready");
      } else if (keepScreen) {
        setFeedback({ kind: "error", message: result.error.message });
      } else {
        setLoadError(result.error);
        setStatus("error");
      }
    },
    [client, filters, page]
  );

  useEffect(() => {
    alive.current = true;
    void load(false);
    return () => {
      alive.current = false;
    };
  }, [load]);

  const reload = useCallback(() => {
    setStatus("loading");
    void load(false);
  }, [load]);

  /** Replaces one or more filters (including the search text) and jumps back to page 1. */
  const updateFilters = useCallback((patch: Partial<ProductFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  }, []);

  /**
   * Runs one mutation; resolves to its error (so a form can show it) or null on success. `successMessage` can
   * be a plain string, or a function of the action's own success data — needed when a single mutation can
   * still count as an overall success while something secondary about it went wrong (e.g. product creation
   * succeeding even though the image attached to it failed to upload).
   */
  const run = useCallback(
    async (action: () => Promise<ApiResult<unknown>>, successMessage: string | ((data: unknown) => string)): Promise<AdminError | null> => {
      setBusy(true);
      setFeedback(null);
      const result = await action();
      await load(true);
      if (!alive.current) return null;
      setBusy(false);
      if (result.ok) {
        setFeedback({ kind: "success", message: typeof successMessage === "function" ? successMessage(result.data) : successMessage });
        return null;
      }
      setFeedback({ kind: "error", message: result.error.message });
      return result.error;
    },
    [load]
  );

  return { rows, total, page, setPage, filters, updateFilters, status, loadError, busy, feedback, dismissFeedback: () => setFeedback(null), reload, run };
}
