/**
 * Turns database / network errors from the owner's customer functions (supabase/migrations/0013_customer_admin.sql)
 * into one Hebrew message the screen can show (pure). The database is the real enforcer — these messages only explain
 * what it refused and why.
 */
import type { AdminError as BaseAdminError, RawApiError } from "@/admin/shared/apiError";
export type { RawApiError };

export type AdminErrorKind = "permission" | "setup-needed" | "network" | "unknown";
export type AdminError = BaseAdminError<AdminErrorKind>;

export const ERROR_MESSAGES: Record<AdminErrorKind, string> = {
  permission: "אין הרשאה לצפות בנתוני הלקוחות. המסך הזה זמין לבעלים בלבד. ייתכן שההתחברות פגה — התנתקו והתחברו מחדש.",
  "setup-needed": "חסר עדכון במסד הנתונים: יש להריץ את הקבצים supabase/migrations/0012_customers.sql ו-0013_customer_admin.sql ב-SQL Editor של Supabase ואז לרענן את העמוד.",
  network: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
  unknown: "הפעולה נכשלה. נסו שוב.",
};

export function describeError(error: RawApiError): AdminError {
  const code = error.code ?? "";
  const text = `${error.message ?? ""} ${error.details ?? ""}`;

  const kind: AdminErrorKind =
    code === "42501" || /NOT_AUTHORIZED|permission denied/i.test(text) ? "permission"
    : code === "PGRST202" || code === "PGRST205" || /could not find the (function|table)/i.test(text) ? "setup-needed"
    : code === "" && /fetch|network|failed to|load failed/i.test(text) ? "network"
    : "unknown";

  return { kind, message: ERROR_MESSAGES[kind] };
}
