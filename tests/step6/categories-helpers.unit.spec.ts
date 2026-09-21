import { test, expect } from "@playwright/test";
import { SLUG_MAX_LENGTH, SLUG_PATTERN, isAmbiguousCategorySlug, suggestSlug, validateSlug } from "../../src/admin/categories/slug";
import { SORT_STEP, moveId, nextSortOrder } from "../../src/admin/categories/ordering";
import { ERROR_MESSAGES, describeError } from "../../src/admin/categories/categoryErrors";

test.describe("suggestSlug", () => {
  test("turns English names into slugs", () => {
    expect(suggestSlug("Hookah Tobacco")).toBe("hookah-tobacco");
    expect(suggestSlug("  Lighters  ")).toBe("lighters");
    expect(suggestSlug("L&M")).toBe("l&m");
    expect(suggestSlug("Rolling / Papers")).toBe("rolling-papers");
    expect(suggestSlug("Café Crème!")).toBe("caf-crme");
    expect(suggestSlug("A  --  B")).toBe("a-b");
    expect(suggestSlug("Pipes_2")).toBe("pipes_2");
  });

  test("returns '' when nothing usable is left", () => {
    expect(suggestSlug("")).toBe("");
    expect(suggestSlug("   ")).toBe("");
    expect(suggestSlug("נרגילות")).toBe("");
    expect(suggestSlug("---")).toBe("");
    expect(suggestSlug("&&&")).toBe("");
  });

  test("never exceeds the length limit and never ends with a separator", () => {
    const slug = suggestSlug("a".repeat(SLUG_MAX_LENGTH - 1) + " b c d");
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug).not.toMatch(/[-_]$/);
    expect(SLUG_PATTERN.test(slug)).toBe(true);
  });

  test("every suggestion is a valid slug", () => {
    for (const name of ["Hookah", "Rolling Papers & Filters", "E-Cigarettes", "Zippo 2024", "x"]) {
      const slug = suggestSlug(name);
      expect(SLUG_PATTERN.test(slug), `${name} -> ${slug}`).toBe(true);
    }
  });
});

test.describe("validateSlug", () => {
  const taken = ["cigarettes", "tobacco"];

  test("accepts good slugs, including the existing l&m style", () => {
    for (const slug of ["hookah", "hookah-tobacco", "l&m", "a1", "x_y", "0day"]) expect(validateSlug(slug, taken), slug).toBeNull();
  });

  test("reports each kind of problem", () => {
    expect(validateSlug("", taken)).toBe("empty");
    expect(validateSlug("Bad", taken)).toBe("format");
    expect(validateSlug("has space", taken)).toBe("format");
    expect(validateSlug("-leading", taken)).toBe("format");
    expect(validateSlug("עברית", taken)).toBe("format");
    expect(validateSlug("x".repeat(SLUG_MAX_LENGTH + 1), taken)).toBe("too-long");
    expect(validateSlug("tobacco", taken)).toBe("taken");
  });

  test("category slugs that are a dash-prefix of another are ambiguous (would open the wrong category from a link)", () => {
    expect(isAmbiguousCategorySlug("cigarettes-plus", taken)).toBe(true); // storefront would resolve #cigarettes-plus to "cigarettes"
    expect(isAmbiguousCategorySlug("tob", ["tobacco"])).toBe(false); // no dash boundary
    expect(isAmbiguousCategorySlug("cig", ["cig-plus"])).toBe(true);
    expect(isAmbiguousCategorySlug("hookah", taken)).toBe(false);
    expect(validateSlug("cigarettes-plus", taken, taken)).toBe("ambiguous");
    expect(validateSlug("cigarettes-plus", taken)).toBeNull(); // subcategories don't use the ambiguity rule
  });
});

test.describe("moveId", () => {
  const ids = ["a", "b", "c"];

  test("moves one place up or down without mutating the input", () => {
    expect(moveId(ids, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(ids, "b", 1)).toEqual(["a", "c", "b"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("returns null at the edges and for unknown ids", () => {
    expect(moveId(ids, "a", -1)).toBeNull();
    expect(moveId(ids, "c", 1)).toBeNull();
    expect(moveId(ids, "zzz", 1)).toBeNull();
    expect(moveId([], "a", 1)).toBeNull();
  });
});

test.describe("nextSortOrder", () => {
  test("puts a new item at the END (the column default 0 would put it first)", () => {
    expect(SORT_STEP).toBe(10);
    expect(nextSortOrder([])).toBe(10);
    expect(nextSortOrder([10, 20])).toBe(30);
    expect(nextSortOrder([0, 0, 0])).toBe(10);
    expect(nextSortOrder([30, 10, 20])).toBe(40);
  });
});

test.describe("describeError", () => {
  test("maps database errors to specific Hebrew messages", () => {
    expect(describeError({ code: "23505", message: 'duplicate key value violates unique constraint "categories_slug_key"' }).kind).toBe("duplicate-slug");
    expect(describeError({ code: "23514", message: 'violates check constraint "categories_name_he_not_blank"' }).kind).toBe("blank-name");
    expect(describeError({ code: "23514", message: 'violates check constraint "subcategories_slug_format"' }).kind).toBe("invalid-slug");
    expect(describeError({ code: "23001", message: "violates RESTRICT setting" }).kind).toBe("in-use");
    expect(describeError({ code: "23503", message: "foreign key" }).kind).toBe("in-use");
    expect(describeError({ code: "42501", message: "permission denied for table categories" }).kind).toBe("permission");
    expect(describeError({ code: "P0001", message: "slug cannot be changed after creation (it is the public #anchor)" }).kind).toBe("slug-locked");
    expect(describeError({ code: "P0001", message: "the list must be exactly the existing categories (reload and try again)" }).kind).toBe("stale-list");
    expect(describeError({ code: "", message: "TypeError: Failed to fetch" }).kind).toBe("network");
    expect(describeError({ code: "PGRST202", message: "Could not find the function public.admin_product_counts in the schema cache" }).kind).toBe("setup-needed");
    expect(ERROR_MESSAGES["setup-needed"]).toContain("0005_admin_categories.sql");
    expect(describeError({ code: "XX000", message: "something else" }).kind).toBe("unknown");
    expect(describeError({}).kind).toBe("unknown");
  });

  test("every kind has a non-empty Hebrew message, and messages carry no internal details", () => {
    for (const [kind, message] of Object.entries(ERROR_MESSAGES)) {
      expect(message, kind).toMatch(/[֐-׿]/);
    }
    const result = describeError({ code: "23505", message: "duplicate key ... Key (slug)=(secret-detail)", details: "secret" });
    expect(result.message).not.toContain("secret");
  });
});
