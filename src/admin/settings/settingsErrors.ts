/**
 * Turns database / network errors from the business-settings admin API into one Hebrew message the screen
 * can show (pure). The database is the real enforcer (see supabase/migrations/0008_business_settings.sql) —
 * these messages only explain what it refused and why.
 */
import type { AdminError as BaseAdminError, RawApiError } from "@/admin/shared/apiError";
export type { RawApiError };

export type AdminErrorKind = "invalid-hours" | "negative-amount" | "window-in-use" | "invalid-window" | "permission" | "setup-needed" | "network" | "unknown";

export type AdminError = BaseAdminError<AdminErrorKind>;

export const ERROR_MESSAGES: Record<AdminErrorKind, string> = {
  "invalid-hours": "יש להזין שעת פתיחה וסגירה תקינות (פתיחה לפני סגירה) לכל יום פתוח.",
  "negative-amount": "הסכום שהוזן אינו תקין.",
  "window-in-use": "אי אפשר למחוק חלון שכבר היו בו ריצות משלוח: המחיקה הייתה מוחקת את ההיסטוריה (מי נסע, מתי, ובאיזו ריצה) ואת הבסיס לשכר השליחים. כדי להפסיק להציע אותו ללקוחות, מבטלים את הסימון \"פעיל\" ושומרים.",
  "invalid-window": "חלון משלוח לא תקין: שעת הסגירה להזמנה חייבת להיות לא אחרי שעת היציאה, והקיבולת (אם הוזנה) חייבת להיות מספר חיובי.",
  permission: "אין הרשאה לבצע את הפעולה. ייתכן שההתחברות פגה — התנתקו והתחברו מחדש.",
  "setup-needed": "חסר עדכון במסד הנתונים: יש להריץ את הקובץ supabase/migrations/0008_business_settings.sql ב-SQL Editor של Supabase ואז לרענן את העמוד.",
  network: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
  unknown: "הפעולה נכשלה. נסו שוב.",
};

export function describeError(error: RawApiError): AdminError {
  const code = error.code ?? "";
  const text = `${error.message ?? ""} ${error.details ?? ""}`;

  const kind: AdminErrorKind =
    code === "23514" ? (/times_when_open/.test(text) ? "invalid-hours" : /_cents_check/.test(text) ? "negative-amount" : /delivery_windows|delivery_advance_hours/.test(text) ? "invalid-window" : "unknown")
    : code === "23503" && /delivery_runs|delivery_windows/.test(text) ? "window-in-use"
    : code === "42501" || /permission denied|row-level security/i.test(text) ? "permission"
    : code === "PGRST202" || code === "PGRST205" || /could not find the (function|table)/i.test(text) ? "setup-needed"
    : code === "" && /fetch|network|failed to|load failed/i.test(text) ? "network"
    : "unknown";

  return { kind, message: ERROR_MESSAGES[kind] };
}
