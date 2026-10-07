import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { loadEvents, loadRedemptions } from "@/admin/coupons/couponsApi";
import {
  addressKey, afterDispatchReleases, CHANGE_FIELD_LABEL, couponStatus, describeCoupon, EVENT_LABEL, formatPhoneLocal, formatUsage, RELEASE_LABEL,
  REDEMPTION_LABEL, sharedAddressKeys, STATUS_LABEL, EMPTY_USAGE,
  type CouponEventRow, type CouponRow, type CouponUsage, type RedemptionRow,
} from "@/admin/coupons/couponsModel";
import { formatDateTime, formatShekel } from "@/admin/orders/orderModel";
import { navigateAdmin } from "@/admin/adminPath";
import { ORDERS_PATH } from "@/admin/orders/ordersRoute";

const orderPath = (orderNumber: number): string => `${ORDERS_PATH}/${orderNumber}`;

interface CouponDetailDrawerProps {
  client: SupabaseClient;
  coupon: CouponRow | null;
  usage: CouponUsage | undefined;
  /** Bumps whenever the parent changed something, so the lists reload. */
  version: number;
  busy: boolean;
  onClose: () => void;
  onEdit: (coupon: CouponRow) => void;
  onDuplicate: (coupon: CouponRow) => void;
  onToggleActive: (coupon: CouponRow) => void;
  onToggleArchived: (coupon: CouponRow) => void;
}

type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

function formatChange(field: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "כן" : "לא";
  if (field.endsWith("_at") && typeof value === "string") return formatDateTime(value);
  return String(value);
}

function Detail({ client, coupon, usage, version, busy, onEdit, onDuplicate, onToggleActive, onToggleArchived }: Omit<CouponDetailDrawerProps, "onClose" | "coupon"> & { coupon: CouponRow }) {
  const [redemptions, setRedemptions] = useState<Loaded<RedemptionRow[]>>({ status: "loading" });
  const [events, setEvents] = useState<Loaded<CouponEventRow[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadRedemptions(client, coupon.id).then((r) => {
      if (!cancelled) setRedemptions(r.ok ? { status: "ready", data: r.data } : { status: "error", message: r.error.message });
    });
    void loadEvents(client, coupon.id).then((r) => {
      if (!cancelled) setEvents(r.ok ? { status: "ready", data: r.data } : { status: "error", message: r.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [client, coupon.id, version]);

  const u = usage ?? EMPTY_USAGE;
  const status = couponStatus(coupon, u);
  const rows = redemptions.status === "ready" ? redemptions.data : [];
  const shared = sharedAddressKeys(rows);
  const afterDispatch = afterDispatchReleases(rows);
  const saved = rows.filter((r) => r.status !== "released").reduce((sum, r) => sum + r.discount_cents, 0);

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <code dir="ltr" className="text-lg font-bold text-brand-gold">{coupon.code}</code>
          <span className="rounded-full border border-brand-border px-2.5 py-0.5 text-xs" data-testid="detail-status">{STATUS_LABEL[status]}</span>
        </div>
        <p className="text-sm text-brand-text">{coupon.title}</p>
        <p className="text-sm text-brand-text-muted">{describeCoupon(coupon)}</p>
        {(coupon.starts_at || coupon.ends_at) && (
          <p className="text-xs text-brand-text-muted">
            {coupon.starts_at ? `מ-${formatDateTime(coupon.starts_at)}` : ""} {coupon.ends_at ? `עד ${formatDateTime(coupon.ends_at)} (לא כולל)` : ""}
          </p>
        )}
        {coupon.internal_note && <p className="mt-1 rounded bg-brand-bg px-2 py-1 text-xs text-brand-text-muted">הערה: {coupon.internal_note}</p>}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-brand-border bg-brand-bg p-2">
          <dt className="text-xs text-brand-text-muted">שימושים</dt>
          <dd className="text-lg font-bold text-brand-text">{formatUsage(coupon, u)}</dd>
        </div>
        <div className="rounded-lg border border-brand-border bg-brand-bg p-2">
          <dt className="text-xs text-brand-text-muted">מומשו / שמורים</dt>
          <dd className="text-lg font-bold text-brand-text">{u.redeemed} / {u.reserved}</dd>
        </div>
        <div className="rounded-lg border border-brand-border bg-brand-bg p-2">
          <dt className="text-xs text-brand-text-muted">סך ההנחות</dt>
          <dd className="text-lg font-bold text-brand-text">{formatShekel(saved)}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onEdit(coupon)}>עריכה</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDuplicate(coupon)}>שכפול</Button>
        {!coupon.archived_at && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onToggleActive(coupon)}>
            {coupon.is_active ? "השבתה" : "הפעלה"}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onToggleArchived(coupon)}>
          {coupon.archived_at ? "שחזור מהארכיון" : "העברה לארכיון"}
        </Button>
      </div>

      <section aria-label="שימושים">
        <h3 className="mb-2 text-sm font-semibold text-brand-gold">שימושים בקופון</h3>
        {redemptions.status === "loading" && <Loader2 size={18} className="animate-spin" aria-label="טוען" />}
        {redemptions.status === "error" && <p role="alert" className="text-sm text-brand-danger">{redemptions.message}</p>}
        {redemptions.status === "ready" && rows.length === 0 && <p className="text-sm text-brand-text-muted">עדיין לא נעשה בו שימוש.</p>}
        {rows.length > 0 && (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const flagged = r.orders ? shared.has(addressKey(r.orders)) : false;
              return (
                <li key={r.id} className="rounded-lg border border-brand-border bg-brand-bg p-2 text-sm" data-testid="redemption-row">
                  <div className="flex items-center justify-between gap-2">
                    {r.orders ? (
                      <a
                        href={orderPath(r.orders.order_number)}
                        onClick={(event) => {
                          event.preventDefault();
                          navigateAdmin(orderPath(r.orders!.order_number));
                        }}
                        className="font-medium text-brand-gold underline underline-offset-2"
                      >
                        הזמנה #{r.orders.order_number}
                      </a>
                    ) : (
                      <span>הזמנה</span>
                    )}
                    <span className="text-brand-text">-{formatShekel(r.discount_cents)}</span>
                  </div>
                  <div className="text-xs text-brand-text-muted">
                    <span dir="ltr">{formatPhoneLocal(r.phone_e164)}</span> · {formatDateTime(r.reserved_at)} · {REDEMPTION_LABEL[r.status]}
                    {r.released_reason ? ` — ${RELEASE_LABEL[r.released_reason] ?? r.released_reason}` : ""}
                  </div>
                  {r.orders && (
                    <div className="text-xs text-brand-text-muted">
                      {r.orders.street ? (
                        <>
                          {r.orders.street} {r.orders.house_number}
                          {r.orders.apartment ? `, דירה ${r.orders.apartment}` : ""}
                        </>
                      ) : (
                        "איסוף עצמי"
                      )}
                    </div>
                  )}
                  {flagged && <div className="mt-1 text-xs text-brand-danger" data-testid="shared-address-flag">שימו לב: כמה מספרי טלפון שונים מימשו את הקופון לאותה כתובת.</div>}
                  {r.released_reason === "order_cancelled_after_dispatch" && (afterDispatch.get(r.phone_e164) ?? 0) > 1 && (
                    <div className="mt-1 text-xs text-brand-danger">למספר הזה {afterDispatch.get(r.phone_e164)} הזמנות עם קופון שבוטלו אחרי יציאה למשלוח.</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="היסטוריית שינויים">
        <h3 className="mb-2 text-sm font-semibold text-brand-gold">היסטוריית שינויים</h3>
        {events.status === "loading" && <Loader2 size={18} className="animate-spin" aria-label="טוען" />}
        {events.status === "error" && <p role="alert" className="text-sm text-brand-danger">{events.message}</p>}
        {events.status === "ready" && (
          <ol className="space-y-2 border-s border-brand-border ps-4 text-sm">
            {events.data.map((e) => (
              <li key={e.id}>
                <div className="text-brand-text">
                  {EVENT_LABEL[e.kind]} <span className="text-xs text-brand-text-muted">· {e.actor_label} · {formatDateTime(e.created_at)}</span>
                </div>
                {e.kind === "updated" && e.changes && (
                  <ul className="text-xs text-brand-text-muted">
                    {Object.entries(e.changes).map(([field, change]) => (
                      <li key={field}>
                        {CHANGE_FIELD_LABEL[field] ?? field}: {formatChange(field, change.from)} ← {formatChange(field, change.to)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** A coupon's details: how it reads, how much it was used and by whom, and the history of changes. */
export function CouponDetailDrawer({ onClose, coupon, ...rest }: CouponDetailDrawerProps) {
  return (
    <Drawer isOpen={coupon !== null} onClose={onClose} title="פרטי קופון" side="right">
      {coupon && <Detail coupon={coupon} {...rest} />}
    </Drawer>
  );
}
