import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadProductGroup, reorderProducts, type ApiResult, type ProductRow } from "@/admin/products/productsApi";
import type { AdminError } from "@/admin/products/productErrors";
import { moveId } from "@/admin/categories/ordering";

export type Feedback = { kind: "success" | "error"; message: string };

/** Which (category, subcategory) group is being reordered. `subcategoryId: null` is the "no subcategory" group. */
export interface GroupSelection {
  categoryId: string;
  subcategoryId: string | null;
}

/**
 * Data + mutations for the products ORDERING tab: pick one (category, subcategory) group, see it in real
 * storefront order, move items with up/down arrows. Deliberately narrower than the list tab — no search, no
 * filters, no cross-group view — because showing only one group at a time is what makes "move" unambiguous:
 * `admin_reorder_products` (see supabase/migrations/0006_admin_products.sql) additionally REFUSES a list that
 * isn't exactly that group's current products, so a product from another category/subcategory can never end
 * up reordered by mistake even if this screen had a bug.
 */
export function useProductOrdering(client: SupabaseClient) {
  const [selection, setSelection] = useState<GroupSelection | null>(null);
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadError, setLoadError] = useState<AdminError | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    // React StrictMode double-mounts in dev (mount -> cleanup -> mount again) to catch exactly this kind of
    // bug: setting alive.current only in the cleanup would leave it permanently false after that, silently
    // dropping every future state update. Reset it to true on (re)mount too.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (sel: GroupSelection, keepScreen: boolean) => {
      const result = await loadProductGroup(client, sel.categoryId, sel.subcategoryId);
      if (!alive.current) return;
      if (result.ok) {
        setRows(result.data);
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

  const selectGroup = useCallback(
    (sel: GroupSelection | null) => {
      setSelection(sel);
      setFeedback(null);
      setRows(null);
      if (sel) {
        setStatus("loading");
        void load(sel, false);
      } else {
        setStatus("idle");
      }
    },
    [load]
  );

  const run = useCallback(
    async (action: () => Promise<ApiResult<unknown>>, successMessage: string): Promise<AdminError | null> => {
      if (!selection) return null;
      setBusy(true);
      setFeedback(null);
      const result = await action();
      await load(selection, true);
      if (!alive.current) return null;
      setBusy(false);
      if (result.ok) {
        setFeedback({ kind: "success", message: successMessage });
        return null;
      }
      setFeedback({ kind: "error", message: result.error.message });
      return result.error;
    },
    [selection, load]
  );

  const move = useCallback(
    (id: string, direction: -1 | 1) => {
      if (!selection || !rows) return;
      const ids = moveId(
        rows.map((row) => row.id),
        id,
        direction
      );
      if (ids) void run(() => reorderProducts(client, selection.categoryId, selection.subcategoryId, ids), "הסדר עודכן");
    },
    [client, selection, rows, run]
  );

  return { selection, selectGroup, rows, status, loadError, busy, feedback, dismissFeedback: () => setFeedback(null), move };
}
