import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCategoryData, type CategoryData } from "@/admin/categories/categoriesApi";

/**
 * Categories + subcategories for pickers, shared by both Products tabs (the list's create/edit form and
 * filters, and the ordering tab's group picker) so they read from ONE fetch instead of each loading its own.
 */
export function useCategoryOptions(client: SupabaseClient) {
  const [data, setData] = useState<CategoryData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const alive = useRef(true);

  const load = useCallback(async () => {
    const result = await loadCategoryData(client);
    if (!alive.current) return;
    if (result.ok) {
      setData(result.data);
      setStatus("ready");
    } else {
      setStatus("error");
    }
  }, [client]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  return { data, status, reload: load };
}
