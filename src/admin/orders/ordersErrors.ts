/**
 * Turns database / network errors from the order-management API into one Hebrew message (pure). The database
 * is the real enforcer (`transition_order()`, RLS — supabase/migrations/0010_order_management.sql); these
 * messages only explain what it refused and why.
 */
import type { AdminError as BaseAdminError, RawApiError } from "@/admin/shared/apiError";
import { STATUS_LABEL, STOCK_RETURN_LABEL, type OrderStatus, type StockReturnStatus } from "@/admin/orders/orderModel";
export type { RawApiError };

export type OrderErrorKind =
  | "stale"
  | "reason-required"
  | "invalid-transition"
  | "not-found"
  | "permission"
  | "setup-needed"
  | "network"
  | "unknown";

export interface OrderError extends BaseAdminError<OrderErrorKind> {
  /** For "stale": what the order's status is right now, so the screen can refresh to it. */
  current?: string;
}

const staleMessage = (current: string | undefined): string => {
  const label = current ? (STATUS_LABEL[current as OrderStatus] ?? STOCK_RETURN_LABEL[current as StockReturnStatus] ?? "") : "";
  return `ההזמנה כבר עודכנה על ידי מישהו אחר${label ? ` (עכשיו: ${label})` : ""}. המסך התרענן.`;
};

export const ERROR_MESSAGES: Record<Exclude<OrderErrorKind, "stale">, string> = {
  "reason-required": "חובה לציין סיבת ביטול.",
  "invalid-transition": "אי אפשר לבצע את המעבר הזה מהמצב הנוכחי של ההזמנה.",
  "not-found": "ההזמנה לא נמצאה.",
  permission: "אין הרשאה לבצע את הפעולה. ייתכן שההתחברות פגה — התנתקו והתחברו מחדש.",
  "setup-needed": "חסר עדכון במסד הנתונים: יש להריץ את הקובץ supabase/migrations/0010_order_management.sql ב-SQL Editor של Supabase ואז לרענן את העמוד.",
  network: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
  unknown: "הפעולה נכשלה. נסו שוב.",
};

export function describeError(error: RawApiError): OrderError {
  const code = error.code ?? "";
  const text = `${error.message ?? ""} ${error.details ?? ""}`;

  const stale = /STALE_STATUS:\s*(\w+)/.exec(text);
  if (stale) return { kind: "stale", current: stale[1], message: staleMessage(stale[1]) };

  const kind: Exclude<OrderErrorKind, "stale"> =
    /REASON_REQUIRED/.test(text) ? "reason-required"
    : /INVALID_TRANSITION|INVALID_STATUS|INVALID_OUTCOME/.test(text) ? "invalid-transition"
    : /ORDER_NOT_FOUND/.test(text) ? "not-found"
    : code === "42501" || /NOT_AUTHORIZED|permission denied|row-level security/i.test(text) ? "permission"
    : code === "PGRST202" || code === "PGRST205" || /could not find the (function|table)|column .* does not exist/i.test(text) ? "setup-needed"
    : code === "" && /fetch|network|failed to|load failed/i.test(text) ? "network"
    : "unknown";

  return { kind, message: ERROR_MESSAGES[kind] };
}
