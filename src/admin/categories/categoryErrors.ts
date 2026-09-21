/**
 * Turns database / network errors from the admin API into one Hebrew message the screen can show (pure).
 * The database is the real enforcer — these messages only explain what it refused and why.
 */
export type AdminErrorKind =
  | "duplicate-slug"
  | "invalid-slug"
  | "blank-name"
  | "in-use"
  | "permission"
  | "slug-locked"
  | "stale-list"
  | "setup-needed"
  | "network"
  | "unknown";

export interface AdminError {
  kind: AdminErrorKind;
  /** Ready to show to the admin. */
  message: string;
}

export const ERROR_MESSAGES: Record<AdminErrorKind, string> = {
  "duplicate-slug": "המזהה (slug) כבר קיים. בחרו מזהה אחר.",
  "invalid-slug": "המזהה יכול לכלול רק אותיות אנגליות קטנות, ספרות, מקף (-), קו תחתון (_) או &, ולהתחיל באות או ספרה.",
  "blank-name": "יש להזין שם בעברית.",
  "in-use": "לא ניתן למחוק — יש בפנים מוצרים או תתי־קטגוריות. אפשר להסתיר במקום למחוק.",
  permission: "אין הרשאה לבצע את הפעולה. ייתכן שההתחברות פגה — התנתקו והתחברו מחדש.",
  "slug-locked": "לא ניתן לשנות מזהה (slug) אחרי היצירה.",
  "stale-list": "הרשימה השתנתה במקום אחר. הנתונים נטענו מחדש — נסו שוב.",
  "setup-needed": "חסר עדכון במסד הנתונים: יש להריץ את הקובץ supabase/migrations/0005_admin_categories.sql ב-SQL Editor של Supabase ואז לרענן את העמוד.",
  network: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
  unknown: "הפעולה נכשלה. נסו שוב.",
};

/** The shape of a PostgREST / supabase-js error (only what we read). */
export interface RawApiError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export function describeError(error: RawApiError): AdminError {
  const code = error.code ?? "";
  const text = `${error.message ?? ""} ${error.details ?? ""}`;

  const kind: AdminErrorKind =
    code === "23505" ? "duplicate-slug"
    : code === "23514" ? (/name_he_not_blank/.test(text) ? "blank-name" : /slug_format/.test(text) ? "invalid-slug" : "unknown")
    : code === "23001" || code === "23503" ? "in-use"
    : code === "42501" || /permission denied|row-level security/i.test(text) ? "permission"
    : /slug cannot be changed/i.test(text) ? "slug-locked"
    : /exactly the existing/i.test(text) ? "stale-list"
    : code === "PGRST202" || /could not find the function/i.test(text) ? "setup-needed"
    : code === "" && /fetch|network|failed to|load failed/i.test(text) ? "network"
    : "unknown";

  return { kind, message: ERROR_MESSAGES[kind] };
}
