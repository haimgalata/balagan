import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listCustomers, loadCustomerStats } from "@/admin/customers/customersApi";
import type { AdminError } from "@/admin/customers/customersErrors";
import type { CustomerList, CustomerStats, MarketingFilter } from "@/admin/customers/customersModel";

export const PAGE_SIZE = 25;

export type Loadable<T> = { status: "loading" } | { status: "error"; error: AdminError } | { status: "ready"; data: T };

/** Stats + the filtered, paginated member list. A slower, older response can never overwrite a newer one. */
export function useCustomers(client: SupabaseClient) {
  const [search, setSearch] = useState("");
  const [marketing, setMarketing] = useState<MarketingFilter>("all");
  const [page, setPage] = useState(0);
  const [stats, setStats] = useState<Loadable<CustomerStats>>({ status: "loading" });
  const [list, setList] = useState<Loadable<CustomerList>>({ status: "loading" });
  const listRequest = useRef(0);

  const reloadStats = useCallback(async () => {
    const result = await loadCustomerStats(client);
    setStats(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
  }, [client]);

  const reloadList = useCallback(async () => {
    const id = ++listRequest.current;
    setList({ status: "loading" });
    const result = await listCustomers(client, { search, marketing, page, pageSize: PAGE_SIZE });
    if (id !== listRequest.current) return;
    setList(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
  }, [client, search, marketing, page]);

  useEffect(() => {
    void reloadStats();
  }, [reloadStats]);
  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  return {
    stats,
    list,
    search,
    marketing,
    page,
    /** a new search / filter always goes back to the first page */
    applySearch: (value: string) => {
      setSearch(value);
      setPage(0);
    },
    applyMarketing: (value: MarketingFilter) => {
      setMarketing(value);
      setPage(0);
    },
    setPage,
    reloadStats,
    reloadList,
  };
}
