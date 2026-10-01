import { useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { exportAudience } from "@/admin/customers/customersApi";
import {
  AUDIENCE_LABELS, MARKETING_FILTERS, buildAudienceCsv, exportFileName, formatIsraelDate, formatPhoneLocal, marketingLabel, memberName,
  type AudienceKind, type CustomerStats, type MarketingFilter,
} from "@/admin/customers/customersModel";
import { downloadTextFile } from "@/admin/customers/downloadFile";
import { PAGE_SIZE, useCustomers } from "@/admin/customers/useCustomers";

const inputClasses =
  "rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50";

const STAT_CARDS: { key: keyof Omit<CustomerStats, "lastExports">; label: string }[] = [
  { key: "members", label: "חברים במועדון" },
  { key: "joined30d", label: "הצטרפו ב-30 הימים האחרונים" },
  { key: "withOrders", label: "הזמינו לפחות פעם אחת" },
  { key: "marketingSms", label: "ניתן לשלוח להם SMS" },
  { key: "marketingEmail", label: "ניתן לשלוח להם אימייל" },
  { key: "withdrawn", label: "הסירו הסכמה לדיוור" },
  { key: "deleted", label: "מחקו את החשבון" },
];

const EXPORT_HELP: Record<AudienceKind, string> = {
  sms: "חברים שהסכימו לקבל דיוור ב-SMS (ההסכמה העדכנית ביותר).",
  email: "חברים שהסכימו לקבל דיוור באימייל ויש להם כתובת אימייל.",
  suppression: "מי שהסיר הסכמה או מחק חשבון. יש להעלות את הרשימה לכלי הדיוור כדי לא לפנות אליהם.",
};

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
      <span>{message}</span>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          נסו שוב
        </Button>
      )}
    </div>
  );
}

/**
 * The owner's view of the club (/admin/customers, owner only): headline numbers, a searchable member list, and the
 * audience exports. The list shows people; the exports are what the marketing law cares about — only members whose
 * LATEST consent covers the channel, plus the do-not-contact list — and every export is logged in the database.
 */
export function CustomersPage({ client }: { client: SupabaseClient }) {
  const c = useCustomers(client);
  const [draftSearch, setDraftSearch] = useState("");
  const [confirming, setConfirming] = useState<AudienceKind | null>(null);
  const [exporting, setExporting] = useState<AudienceKind | null>(null);
  const [exportResult, setExportResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const runExport = async (kind: AudienceKind) => {
    setConfirming(null);
    setExporting(kind);
    setExportResult(null);
    const result = await exportAudience(client, kind);
    setExporting(null);
    if (!result.ok) {
      setExportResult({ kind: "error", message: result.error.message });
      return;
    }
    if (result.data.length === 0) {
      setExportResult({ kind: "success", message: `${AUDIENCE_LABELS[kind]}: אין כרגע אף אחד ברשימה הזו, לכן לא הורד קובץ. הבקשה נרשמה ביומן.` });
    } else {
      const fileName = exportFileName(kind, new Date());
      downloadTextFile(fileName, buildAudienceCsv(kind, result.data));
      setExportResult({ kind: "success", message: `${AUDIENCE_LABELS[kind]}: הורדו ${result.data.length} שורות (${fileName}). הייצוא נרשם ביומן.` });
    }
    void c.reloadStats();
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    c.applySearch(draftSearch);
  };

  const total = c.list.status === "ready" ? c.list.data.total : 0;
  const from = total === 0 ? 0 : c.page * PAGE_SIZE + 1;
  const to = Math.min(total, (c.page + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold text-brand-text">לקוחות</h1>

      {/* ---- headline numbers */}
      {c.stats.status === "error" ? (
        <ErrorBox message={c.stats.error.message} onRetry={() => void c.reloadStats()} />
      ) : (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {STAT_CARDS.map(({ key, label }) => (
            <div key={key} className="rounded-lg border border-brand-border bg-brand-bg-elevated p-3">
              <dt className="text-xs text-brand-text-muted">{label}</dt>
              <dd className="mt-1 text-2xl font-bold text-brand-gold">
                {c.stats.status === "ready" ? c.stats.data[key] : <Loader2 size={20} className="animate-spin" aria-label="טוען" />}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* ---- exports */}
      <section aria-labelledby="exports-title" className="rounded-xl border border-brand-border bg-brand-bg-elevated p-4">
        <h2 id="exports-title" className="text-base font-semibold text-brand-text">
          ייצוא רשימות
        </h2>
        <p className="mt-1 text-sm text-brand-text-muted">
          הרשימות כוללות רק חברים שהסכמתם העדכנית מכסה את הערוץ, כך שאפשר לפנות אליהם בדיוור שיווקי. כל ייצוא נרשם ביומן, עם מי ייצא, מה וכמה שורות.
        </p>

        <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {(["sms", "email", "suppression"] as const).map((kind) => {
            const last = c.stats.status === "ready" ? c.stats.data.lastExports[kind] : undefined;
            return (
              <li key={kind} className="flex flex-col gap-2 rounded-lg border border-brand-border bg-brand-bg p-3">
                <span className="text-sm font-medium text-brand-text">{AUDIENCE_LABELS[kind]}</span>
                <span className="text-xs text-brand-text-muted">{EXPORT_HELP[kind]}</span>
                {last && (
                  <span className="text-xs text-brand-text-muted">
                    ייצוא אחרון: {formatIsraelDate(last.at)} · {last.count} שורות
                  </span>
                )}
                {confirming === kind ? (
                  <div role="group" aria-label={`אישור ייצוא ${AUDIENCE_LABELS[kind]}`} className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-brand-danger">הקובץ יכיל פרטים אישיים והייצוא יירשם ביומן. להמשיך?</span>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" onClick={() => void runExport(kind)}>
                        כן, לייצא
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                        ביטול
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Button type="button" size="sm" variant="outline" disabled={exporting !== null} onClick={() => setConfirming(kind)}>
                      {exporting === kind ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                      ייצוא {AUDIENCE_LABELS[kind]}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div aria-live="polite" className="mt-3 min-h-[1.5rem]">
          {exportResult && (
            <p role={exportResult.kind === "error" ? "alert" : "status"} className={`text-sm ${exportResult.kind === "error" ? "text-brand-danger" : "text-brand-success"}`}>
              {exportResult.message}
            </p>
          )}
        </div>
      </section>

      {/* ---- the member list */}
      <section aria-labelledby="members-title" className="flex flex-col gap-3">
        <h2 id="members-title" className="text-base font-semibold text-brand-text">
          רשימת החברים
        </h2>

        <form onSubmit={submitSearch} className="flex flex-wrap items-end gap-3" role="search" aria-label="חיפוש חברים">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-brand-text-muted">
            חיפוש (שם, טלפון או אימייל)
            <input value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} className={inputClasses} placeholder="050-0000000" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-brand-text-muted">
            הסכמה לדיוור
            <select value={c.marketing} onChange={(event) => c.applyMarketing(event.target.value as MarketingFilter)} className={inputClasses}>
              {MARKETING_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            חיפוש
          </Button>
        </form>

        {c.list.status === "error" ? (
          <ErrorBox message={c.list.error.message} onRetry={() => void c.reloadList()} />
        ) : c.list.status === "loading" ? (
          <div role="status" className="flex items-center gap-2 py-8 text-sm text-brand-text-muted">
            <Loader2 size={18} className="animate-spin text-brand-gold" aria-hidden="true" />
            טוען…
          </div>
        ) : c.list.data.rows.length === 0 ? (
          <p className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center text-sm text-brand-text-muted">לא נמצאו חברים.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-brand-border">
            <table className="w-full min-w-[44rem] text-start text-sm">
              <thead className="bg-brand-bg-elevated text-xs text-brand-text-muted">
                <tr>
                  {["שם", "טלפון", "אימייל", "הצטרפות", "הזמנה אחרונה", "הזמנות", "דיוור"].map((heading) => (
                    <th key={heading} scope="col" className="px-3 py-2 text-start font-medium">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.list.data.rows.map((row) => (
                  <tr key={row.id} className="border-t border-brand-border">
                    <td className="px-3 py-2 text-brand-text">{memberName(row) || <span className="text-brand-text-muted">—</span>}</td>
                    <td className="px-3 py-2 text-brand-text" dir="ltr">
                      {formatPhoneLocal(row.phone)}
                    </td>
                    <td className="px-3 py-2 text-brand-text" dir="ltr">
                      {row.email ?? <span className="text-brand-text-muted">—</span>}
                    </td>
                    <td className="px-3 py-2 text-brand-text-muted">{formatIsraelDate(row.joinedAt)}</td>
                    <td className="px-3 py-2 text-brand-text-muted">{formatIsraelDate(row.lastOrderAt) || "—"}</td>
                    <td className="px-3 py-2 text-brand-text">{row.ordersCount}</td>
                    <td className={`px-3 py-2 ${row.marketing ? "text-brand-text" : "text-brand-danger"}`}>{marketingLabel(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {c.list.status === "ready" && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-brand-text-muted">
            <span>
              מציג {from}–{to} מתוך {total}
            </span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={c.page === 0} onClick={() => c.setPage(c.page - 1)}>
                הקודם
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={to >= total} onClick={() => c.setPage(c.page + 1)}>
                הבא
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
