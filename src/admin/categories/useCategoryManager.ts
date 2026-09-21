import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCategoryData, type ApiResult, type CategoryData } from "@/admin/categories/categoriesApi";
import type { AdminError } from "@/admin/categories/categoryErrors";

export type Feedback = { kind: "success" | "error"; message: string };

/**
 * Data + mutations for the categories screen.
 *
 * Every mutation goes through `run`, which reloads the list from the database afterwards — also after a failure —
 * so what is on screen always matches what is stored (a stale list, a rejected change or another tab's edit can
 * never leave the screen out of step). One mutation at a time (`busy`).
 */
export function useCategoryManager(client: SupabaseClient) {
  const [data, setData] = useState<CategoryData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<AdminError | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const alive = useRef(true);

  const load = useCallback(
    async (keepScreen: boolean) => {
      const result = await loadCategoryData(client);
      if (!alive.current) return;
      if (result.ok) {
        setData(result.data);
        setLoadError(null);
        setStatus("ready");
      } else if (keepScreen) {
        setFeedback({ kind: "error", message: result.error.message });
      } else {
        setLoadError(result.error);
        setStatus("error");
      }
    },
    [client]
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

  /** Runs one mutation; resolves to its error (so a form can show it) or null on success. */
  const run = useCallback(
    async (action: () => Promise<ApiResult<unknown>>, successMessage: string): Promise<AdminError | null> => {
      setBusy(true);
      setFeedback(null);
      const result = await action();
      await load(true);
      if (!alive.current) return null;
      setBusy(false);
      if (result.ok) {
        setFeedback({ kind: "success", message: successMessage });
        return null;
      }
      setFeedback({ kind: "error", message: result.error.message });
      return result.error;
    },
    [load]
  );

  return { data, status, loadError, busy, feedback, dismissFeedback: () => setFeedback(null), reload, run };
}
