import type { Category } from "@/storefront/types";

/**
 * ORIGINAL static navigation data — now only the SOURCE for one-off scripts
 * (seed / fallback-catalog generators, baseline capture). The storefront reads
 * categories from the database (fallback: `src/storefront/data/fallbackCatalog.ts`); manage
 * categories in the admin. Editing this file changes nothing on the site.
 *
 * `slug` on a category matches the `category` field in `seed-data/products.ts`.
 * `slug` on a subcategory matches the product's brand-derived slug within that category.
 */
export const categories: Category[] = [
  {
    id: "cat-cigarettes",
    name: "סיגריות",
    slug: "cigarettes",
    subcategories: [
      { id: "sub-marlboro", name: "מרלבורו", slug: "marlboro" },
      { id: "sub-winston", name: "ווינסטון", slug: "winston" },
      { id: "sub-pall-mall", name: "פאל מאל", slug: "pall-mall" },
      { id: "sub-next", name: "נקסט", slug: "next" },
      { id: "sub-parliament", name: "פארלמנט", slug: "parliament" },
      { id: "sub-lm", name: "אל אמ", slug: "l&m" },
      { id: "sub-camel", name: "כאמל", slug: "camel" },
      { id: "sub-alor", name: "אלור", slug: "alor" },
      { id: "sub-ld", name: "אל די", slug: "ld" },
      { id: "sub-davidoff", name: "דוידוף", slug: "davidoff" },
      { id: "sub-noblesse", name: "נובלס", slug: "noblesse" },
      { id: "sub-vogue", name: "ווג", slug: "vogue" },
      { id: "sub-golf", name: "גולף", slug: "golf" },
      { id: "sub-pine", name: "פיין", slug: "pine" },
      { id: "sub-time", name: "טיים", slug: "time" },
      { id: "sub-kent", name: "קנט", slug: "kent" },
      { id: "sub-canadian", name: "קנדיאן", slug: "canadian" },
      { id: "sub-maryland", name: "מרילנד", slug: "maryland" },
      { id: "sub-infinity", name: "אינפיניטי", slug: "infinity" },
      { id: "sub-this", name: "THIS", slug: "this" },
    ],
  },
  {
    id: "cat-tobacco",
    name: "טבק",
    slug: "tobacco",
    subcategories: [
      { id: "sub-tobacco-marlboro", name: "מרלבורו", slug: "marlboro" },
      { id: "sub-tobacco-winston", name: "ווינסטון", slug: "winston" },
      { id: "sub-tobacco-pall-mall", name: "פאל מאל", slug: "pall-mall" },
      { id: "sub-tobacco-next", name: "נקסט", slug: "next" },
      { id: "sub-golden-virginia", name: "גולדן וירג׳יניה", slug: "golden-virginia" },
      { id: "sub-bali-shag", name: "באלי שאג", slug: "bali-shag" },
      { id: "sub-chesterfield", name: "צ׳סטרפילד", slug: "chesterfield" },
      { id: "sub-tobacco-camel", name: "כאמל", slug: "camel" },
      { id: "sub-natural-american-spirit", name: "נטורל אמריקן ספיריט", slug: "natural-american-spirit" },
      { id: "sub-manitou", name: "מאניטו", slug: "manitou" },
      { id: "sub-choice", name: "צ'וייס", slug: "choice" },
      { id: "sub-captain-black", name: "קפטן בלאק", slug: "captain-black" },
    ],
  },

  /**
   * To add a new main category (e.g. נרגילות / מצתים / אביזרים),
   * just push another object here — the navigation renders it
   * automatically:
   *
   * {
   *   id: "cat-accessories",
   *   name: "אביזרים",
   *   slug: "accessories",
   *   subcategories: [],
   * },
   */
];
