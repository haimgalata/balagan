import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBusinessSettingsData, type ApiResult, type BusinessSettingsData } from "@/admin/settings/settingsApi";
import type { AdminError } from "@/admin/settings/settingsErrors";

export type Feedback = { kind: "success" | "error"; message: string };

/**
 * Data + mutations for the Business Settings screen.
 *
 * Every mutation goes through `run`, which reloads the data from the database afterwards — also after a
 * failure — so what is on screen always matches what is stored. One mutation at a time (`busy`).
 */
export function useBusinessSettingsManager(client: SupabaseClient) {
  const [data, setData] = useState<BusinessSettingsData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<AdminError | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const alive = useRef(true);

  const load = useCallback(
    async (keepScreen: boolean) => {
      const result = await loadBusinessSettingsData(client);
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

  /** Runs one mutation; resolves to its error (so the form can show it) or null on success. */
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
