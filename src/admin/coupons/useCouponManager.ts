import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCoupon, listCoupons, setCouponActive, setCouponArchived, updateCoupon, type CouponListData } from "@/admin/coupons/couponsApi";
import type { AdminError } from "@/admin/coupons/couponsErrors";
import type { CouponRow } from "@/admin/coupons/couponsModel";

export type Loadable<T> = { status: "loading" } | { status: "error"; error: AdminError } | { status: "ready"; data: T };

/** The coupon list plus the owner's actions on it. Every action resolves to the error to show (or null) and reloads the list. */
export function useCouponManager(client: SupabaseClient) {
  const [list, setList] = useState<Loadable<CouponListData>>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  /** Bumped after every change so open detail panels reload their usage + history. */
  const [version, setVersion] = useState(0);
  const request = useRef(0);

  const reload = useCallback(async () => {
    const id = ++request.current;
    const result = await listCoupons(client);
    if (id !== request.current) return;
    setList(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
    setVersion((v) => v + 1);
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(
    async (action: () => Promise<{ ok: true; data: CouponRow } | { ok: false; error: AdminError }>): Promise<{ error: AdminError | null; coupon: CouponRow | null }> => {
      setBusy(true);
      const result = await action();
      if (result.ok) await reload();
      setBusy(false);
      return result.ok ? { error: null, coupon: result.data } : { error: result.error, coupon: null };
    },
    [reload]
  );

  return {
    list,
    busy,
    version,
    reload,
    create: (body: Record<string, unknown>) => run(() => createCoupon(client, body)),
    update: (id: string, body: Record<string, unknown>) => run(() => updateCoupon(client, id, body)),
    setActive: (id: string, active: boolean) => run(() => setCouponActive(client, id, active)),
    setArchived: (id: string, archived: boolean) => run(() => setCouponArchived(client, id, archived)),
  };
}
