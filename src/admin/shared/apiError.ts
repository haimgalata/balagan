/**
 * Shared shapes for admin error handling. Each admin area (categories/products/settings) has its own
 * `AdminErrorKind` union, `ERROR_MESSAGES` map, and `describeError()` mapping logic — those are genuinely
 * domain-specific (different database constraints, different Hebrew messages) and stay local to each area.
 */

export interface AdminError<Kind extends string = string> {
  kind: Kind;
  /** Ready to show to the admin. */
  message: string;
}

/** The shape of a PostgREST / supabase-js error (only what we read). */
export interface RawApiError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}
