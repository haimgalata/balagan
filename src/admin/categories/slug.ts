/**
 * Slug rules for categories and subcategories (pure — unit-tested without a browser).
 *
 * A slug is the public `#anchor` of a category (`#cigarettes`) or subcategory (`#cigarettes-marlboro`), used in
 * links and bookmarks. It is chosen once, when the item is created, and never changed afterwards (the database
 * enforces that too — see supabase/migrations/0005_admin_categories.sql). The format mirrors the database CHECK.
 */

/** Same pattern as the database CHECK: starts with a lowercase letter or digit, then letters, digits, `&`, `_`, `-`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9&_-]*$/;
export const SLUG_MAX_LENGTH = 40;

export type SlugProblem = "empty" | "format" | "too-long" | "taken" | "ambiguous";

/**
 * Turns an English name into a suggested slug: "Hookah Tobacco" -> "hookah-tobacco", "L&M" -> "l&m".
 * Returns "" when nothing usable is left (e.g. a name with no English letters or digits).
 */
export function suggestSlug(englishName: string): string {
  const slug = englishName
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/[^a-z0-9&_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_&]+/, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/[-_]+$/, "");
  return SLUG_PATTERN.test(slug) ? slug : "";
}

/**
 * Two category slugs must not be "prefix + dash" of each other (`cigarettes` and `cigarettes-plus`): the storefront
 * resolves `#cigarettes-plus` by looking for a category whose slug is a dash-prefix of the hash, so it would open the
 * wrong category. Subcategory anchors are `category-subcategory`, so the same reasoning applies to category slugs only.
 */
export function isAmbiguousCategorySlug(slug: string, otherCategorySlugs: readonly string[]): boolean {
  return otherCategorySlugs.some((other) => slug.startsWith(`${other}-`) || other.startsWith(`${slug}-`));
}

/**
 * First problem with a slug, or null when it is fine.
 * @param takenSlugs slugs that already exist in the same scope (all categories, or the subcategories of one category)
 * @param otherCategorySlugs for CATEGORY slugs: the other categories' slugs (enables the ambiguity check)
 */
export function validateSlug(
  slug: string,
  takenSlugs: readonly string[],
  otherCategorySlugs?: readonly string[]
): SlugProblem | null {
  if (slug === "") return "empty";
  if (slug.length > SLUG_MAX_LENGTH) return "too-long";
  if (!SLUG_PATTERN.test(slug)) return "format";
  if (takenSlugs.includes(slug)) return "taken";
  if (otherCategorySlugs && isAmbiguousCategorySlug(slug, otherCategorySlugs)) return "ambiguous";
  return null;
}
