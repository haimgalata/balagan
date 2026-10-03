import { MobileLabel, RT_BODY, RT_CELL, RT_HEAD, RT_ROW, RT_TABLE } from "@/admin/shared/responsiveTable";
import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ChevronRight, ChevronLeft, Loader2, Search } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import type { AdminRole } from "@/admin/useAdminSession";
import { OrderDetailContent, StatusBadge } from "@/admin/orders/OrderDetailContent";
import { EMPTY_FILTERS, HISTORY_PAGE_SIZE, searchOrders, type HistoryFilters, type HistoryPage } from "@/admin/orders/ordersApi";
import type { OrderError } from "@/admin/orders/ordersErrors";
import { useOrderActions } from "@/admin/orders/useOrderActions";
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  STATUS_LABEL,
  addressLine,
  formatDateTime,
  formatShekel,
  fullName,
  type OrderRow,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
} from "@/admin/orders/orderModel";

const selectClass = "rounded-md border border-brand-border bg-brand-bg px-2.5 py-2 text-sm text-brand-text outline-none focus:border-brand-gold";

/**
 * Order history. Owner: full search + filters over every order. Staff: a search box only (phone / order
 * number / name), and nothing is listed until something is typed — the database itself limits staff to open
 * orders and the last 7 days, this just doesn't pretend to be a browsing screen for them.
 */
export function OrdersHistoryPage({ client, role }: { client: SupabaseClient; role: AdminRole }) {
  const isOwner = role === "owner";
  const [draft, setDraft] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [result, setResult] = useState<HistoryPage | null>(null);
  const [error, setError] = useState<OrderError | null>(null);
  const [loading, setLoading] = useState(false);
  const [openOrder, setOpenOrder] = useState<OrderRow | null>(null);
  const [version, setVersion] = useState(0);

  const mustSearch = !isOwner && applied.text.trim() === "";

  const load = useCallback(async () => {
    if (mustSearch) {
      setResult(null);
      return;
    }
    setLoading(true);
    const res = await searchOrders(client, applied);
    setLoading(false);
    if (res.ok) {
      setResult(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
  }, [client, applied, mustSearch]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const actions = useOrderActions(client, useCallback(async () => setVersion((v) => v + 1), []));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setApplied({ ...draft, page: 0 });
  };
  const reset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / HISTORY_PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4" data-testid="orders-history">
      <form onSubmit={submit} className="space-y-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-3">
        <div className="flex flex-wrap gap-2">
          <label className="relative w-full min-w-0 flex-1 sm:min-w-[14rem]">
            <span className="sr-only">חיפוש הזמנה</span>
            <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-brand-text-muted" aria-hidden="true" />
            <input
              type="search"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder={isOwner ? "מספר הזמנה, טלפון, שם או רחוב" : "מספר הזמנה או טלפון"}
              className="w-full rounded-md border border-brand-border bg-brand-bg py-2 pe-3 ps-9 text-sm text-brand-text outline-none focus:border-brand-gold"
            />
          </label>
          <Button type="submit">חיפוש</Button>
          {(applied.text || isOwner) && (
            <Button type="button" variant="ghost" onClick={reset}>
              ניקוי
            </Button>
          )}
        </div>

        {isOwner ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs text-brand-text-muted">
              סטטוס
              <select aria-label="סטטוס הזמנה" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as OrderStatus | "" })} className={selectClass}>
                <option value="">הכול</option>
                {(Object.keys(STATUS_LABEL) as OrderStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-brand-text-muted">
              אמצעי תשלום
              <select aria-label="אמצעי תשלום" value={draft.paymentMethod} onChange={(e) => setDraft({ ...draft, paymentMethod: e.target.value as PaymentMethod | "" })} className={selectClass}>
                <option value="">הכול</option>
                {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-brand-text-muted">
              סטטוס תשלום
              <select aria-label="סטטוס תשלום" value={draft.paymentStatus} onChange={(e) => setDraft({ ...draft, paymentStatus: e.target.value as PaymentStatus | "" })} className={selectClass}>
                <option value="">הכול</option>
                {(Object.keys(PAYMENT_STATUS_LABEL) as PaymentStatus[]).map((p) => (
                  <option key={p} value={p}>
                    {PAYMENT_STATUS_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-brand-text-muted">
              מתאריך
              <input type="date" value={draft.fromDate} onChange={(e) => setDraft({ ...draft, fromDate: e.target.value })} className={selectClass} />
            </label>
            <label className="grid gap-1 text-xs text-brand-text-muted">
              עד תאריך
              <input type="date" value={draft.toDate} onChange={(e) => setDraft({ ...draft, toDate: e.target.value })} className={selectClass} />
            </label>
          </div>
        ) : (
          <p className="text-xs text-brand-text-muted">אפשר לחפש הזמנות פתוחות והזמנות מ־7 הימים האחרונים.</p>
        )}
      </form>

      {error && (
        <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {error.message}
        </p>
      )}
      {loading && (
        <div role="status" className="flex justify-center p-6 text-brand-gold">
          <Loader2 className="animate-spin" aria-label="טוען" />
        </div>
      )}
      {mustSearch && !loading && <p className="p-6 text-center text-sm text-brand-text-muted">הקלידו מספר הזמנה או טלפון כדי לחפש.</p>}

      {result && !mustSearch && (
        <>
          <p className="text-sm text-brand-text-muted" data-testid="history-count">
            {result.total} הזמנות
          </p>
          {result.rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-brand-border p-6 text-center text-sm text-brand-text-muted">לא נמצאו הזמנות.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-brand-border">
              <table className={RT_TABLE}>
                <thead className={`bg-brand-bg-elevated text-start text-xs text-brand-text-muted ${RT_HEAD}`}>
                  <tr>
                    {["מס׳", "תאריך", "לקוח", "כתובת", "סכום", "תשלום", "סטטוס"].map((h) => (
                      <th key={h} scope="col" className="px-3 py-2 text-start font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className={`divide-y divide-brand-border ${RT_BODY}`}>
                  {result.rows.map((o) => (
                    <tr key={o.id} data-testid="history-row" data-order-number={o.order_number} onClick={() => setOpenOrder(o)} className={`cursor-pointer hover:bg-brand-bg-elevated ${RT_ROW}`}>
                      <td className={`${RT_CELL} font-semibold`}>
                        <MobileLabel>מס׳</MobileLabel>
                        <button type="button" onClick={() => setOpenOrder(o)} className="text-brand-gold hover:underline">
                          #{o.order_number}
                        </button>
                      </td>
                      <td className={`${RT_CELL} text-brand-text-muted`}>
                        <MobileLabel>תאריך</MobileLabel>
                        <span>{formatDateTime(o.created_at)}</span>
                      </td>
                      <td className={RT_CELL}>
                        <MobileLabel>לקוח</MobileLabel>
                        <span>{fullName(o)}</span>
                      </td>
                      <td className={`${RT_CELL} text-brand-text-muted`}>
                        <MobileLabel>כתובת</MobileLabel>
                        <span>{addressLine(o)}</span>
                      </td>
                      <td className={RT_CELL}>
                        <MobileLabel>סכום</MobileLabel>
                        <span>{formatShekel(o.total_cents)}</span>
                      </td>
                      <td className={`${RT_CELL} text-brand-text-muted`}>
                        <MobileLabel>תשלום</MobileLabel>
                        <span>
                          {PAYMENT_METHOD_LABEL[o.payment_method]} · {PAYMENT_STATUS_LABEL[o.payment_status]}
                        </span>
                      </td>
                      <td className={RT_CELL}>
                        <MobileLabel>סטטוס</MobileLabel>
                        <StatusBadge status={o.order_status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            <nav aria-label="עמודים" className="flex items-center justify-center gap-3 text-sm">
              <Button size="sm" variant="secondary" disabled={applied.page === 0} onClick={() => setApplied({ ...applied, page: applied.page - 1 })}>
                <ChevronRight size={16} aria-hidden="true" />
                הקודם
              </Button>
              <span className="text-brand-text-muted">
                עמוד {applied.page + 1} מתוך {pages}
              </span>
              <Button size="sm" variant="secondary" disabled={applied.page + 1 >= pages} onClick={() => setApplied({ ...applied, page: applied.page + 1 })}>
                הבא
                <ChevronLeft size={16} aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}

      <Drawer isOpen={openOrder !== null} onClose={() => setOpenOrder(null)} title={openOrder ? `הזמנה #${openOrder.order_number}` : "הזמנה"} side="left" widthClassName="max-w-xl">
        {openOrder && <OrderDetailContent client={client} orderKey={{ id: openOrder.id }} role={role} actions={actions} version={version} />}
      </Drawer>
    </div>
  );
}
