import type { Category } from "@/types";

/**
 * Site navigation data.
 *
 * This is the ONLY place category/brand structure is defined.
 * `CategoryCard` (homepage category buttons) and `CategorySection`
 * (brand headings + product sliders) both render from this array —
 * adding a category or subcategory here is enough, no component
 * changes are needed.
 *
 * `slug` on a category must match the `category` field used in
 * `src/data/products.ts`. `slug` on a subcategory is used to filter
 * products by brand within that category.
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
