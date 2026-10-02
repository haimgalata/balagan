/**
 * Turns database / network errors from the owner's coupon tables (supabase/migrations/0014_coupons.sql) into one Hebrew
 * message the screen can show (pure). The database is the real enforcer — these messages only explain what it refused.
 */
import type { AdminError as BaseAdminError, RawApiError } from "@/admin/shared/apiError";
export type { RawApiError };

export type AdminErrorKind = "duplicate-code" | "locked" | "invalid" | "permission" | "setup-needed" | "network" | "unknown";
export type AdminError = BaseAdminError<AdminErrorKind>;

export const ERROR_MESSAGES: Record<AdminErrorKind, string> = {
  "duplicate-code": "קוד הקופון כבר קיים (גם קופון בארכיון שומר את הקוד שלו). בחרו קוד אחר.",
  locked: "אי אפשר לשנות את הקוד, סוג ההנחה או ערכה אחרי שהקופון כבר נוצל. שכפלו את הקופון כדי ליצור גרסה חדשה.",
  invalid: "אחד הערכים לא תקין. בדקו את הקוד, ההנחה, התאריכים והמגבלות ונסו שוב.",
  permission: "אין הרשאה לנהל קופונים. המסך הזה זמין לבעלים בלבד. ייתכן שההתחברות פגה — התנתקו והתחברו מחדש.",
  "setup-needed": "חסר עדכון במסד הנתונים: יש להריץ את הקובץ supabase/migrations/0014_coupons.sql ב-SQL Editor של Supabase ואז לרענן את העמוד.",
  network: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
  unknown: "הפעולה נכשלה. נסו שוב.",
};

export function describeError(error: RawApiError): AdminError {
  const code = error.code ?? "";
  const text = `${error.message ?? ""} ${error.details ?? ""}`;

  const kind: AdminErrorKind =
    code === "23505" || /duplicate key|coupons_code_key/i.test(text) ? "duplicate-code"
    : /CODE_LOCKED|COUPON_LOCKED/.test(text) ? "locked"
    : code === "23514" || code === "22P02" || /violates check constraint/i.test(text) ? "invalid"
    : code === "42501" || /NOT_AUTHORIZED|permission denied|row-level security/i.test(text) ? "permission"
    : code === "PGRST205" || code === "42P01" || code === "42703" || /could not find the (function|table)|does not exist|schema cache/i.test(text) ? "setup-needed"
    : code === "" && /fetch|network|failed to|load failed/i.test(text) ? "network"
    : "unknown";

  return { kind, message: ERROR_MESSAGES[kind] };
}
