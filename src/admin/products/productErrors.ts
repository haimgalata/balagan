/**
 * Turns database / network / storage errors from the admin API into one Hebrew message the screen can show
 * (pure). The database is the real enforcer — client-side validation (see productValidation.ts) should catch
 * almost everything before it gets this far; these messages only explain what slipped through and why.
 */
export type AdminErrorKind =
  | "blank-name"
  | "duplicate-barcode"
  | "invalid-price"
  | "invalid-package"
  | "invalid-stock"
  | "invalid-image"
  | "in-use"
  | "permission"
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
  "blank-name": "יש להזין שם בעברית.",
  "duplicate-barcode": "הברקוד הזה כבר שייך למוצר אחר.",
  "invalid-price": "אחד המחירים אינו תקין — מחיר המבצע חייב להיות נמוך מהמחיר הרגיל, וכל מחיר חייב להיות 0 ומעלה.",
  "invalid-package": "פרטי האריזה חסרים או שגויים (תווית, כמות יחידות, מחיר).",
  "invalid-stock": "כמות המלאי חייבת להיות מספר שלם 0 ומעלה.",
  "invalid-image": "התמונה לא תקינה. יש להעלות קובץ JPEG, PNG או WebP בגודל עד 2MB.",
  "in-use": "לא ניתן למחוק כרגע. אפשר להסתיר במקום למחוק.",
  permission: "אין הרשאה לבצע את הפעולה. ייתכן שההתחברות פגה — התנתקו והתחברו מחדש.",
  "stale-list": "הרשימה השתנתה במקום אחר. הנתונים נטענו מחדש — נסו שוב.",
  "setup-needed": "חסר עדכון במסד הנתונים: יש להריץ את הקובץ supabase/migrations/0006_admin_products.sql ב-SQL Editor של Supabase ואז לרענן את העמוד.",
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
    code === "23505" && /barcode/.test(text) ? "duplicate-barcode"
    : code === "23514" ? (
        /name_he_not_blank/.test(text) ? "blank-name"
        : /stock_base_units/.test(text) ? "invalid-stock"
        : /package_/.test(text) ? "invalid-package"
        : /price|sale_valid/.test(text) ? "invalid-price"
        : "unknown"
      )
    : code === "23503" ? "invalid-package" // e.g. a subcategory that doesn't belong to the chosen category
    : code === "42501" || /permission denied|row-level security/i.test(text) ? "permission"
    : /exactly the existing/i.test(text) ? "stale-list"
    : code === "PGRST202" || /could not find the function/i.test(text) ? "setup-needed"
    : code === "" && /fetch|network|failed to|load failed/i.test(text) ? "network"
    : "unknown";

  return { kind, message: ERROR_MESSAGES[kind] };
}
