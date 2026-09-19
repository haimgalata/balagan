/**
 * Pre-migration baseline: freezes the static catalog (src/data/*) plus the
 * OLD pricing rules (src/lib/pricing.ts) into tests/baseline/catalog.json.
 *
 * Purpose: after the Supabase migration, the database and the storefront are
 * diffed against this file to prove IDs, order, navigation and prices did not
 * change. See tests/baseline/README.md.
 *
 * Zero dependencies: Node >= 22.6 imports the .ts files directly (type
 * stripping). Run from the repo root:  node --no-warnings scripts/baseline/capture-catalog.mjs
 *
 * The output is deterministic (no timestamps) so re-running on the same
 * source produces a byte-identical file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { products } = await import(new URL("../../src/data/products.ts", import.meta.url));
const { categories } = await import(new URL("../../src/data/categories.ts", import.meta.url));
const pricing = await import(new URL("../../src/lib/pricing.ts", import.meta.url));

/** Same derivation as `subcategorySlugOf` in src/components/CategorySection.tsx. */
const subcategorySlugOf = (p) => p.subcategorySlug ?? p.brand.toLowerCase().replace(/\s+/g, "-");

const productRows = products.map((p, index) => ({
  position: index, // index in the products.ts array
  id: p.id,
  name: p.name,
  brand: p.brand,
  category: p.category,
  subcategory: subcategorySlugOf(p),
  unitPrice: p.unitPrice,
  // OLD global pack rule, computed with the current pricing.ts (10 units, -₪10):
  oldPackRegular: pricing.getRegularPackPrice(p.unitPrice),
  oldPackPrice: pricing.getPackPrice(p.unitPrice),
  inStock: p.inStock,
  image: p.image,
  description: p.description ?? null,
}));

// Storefront render order per category: subcategories in categories.ts order,
// products in products.ts array order inside each subcategory (CategorySection).
const tree = categories.map((category) => {
  const inCategory = productRows.filter((p) => p.category === category.slug);
  const knownSubs = new Set(category.subcategories.map((s) => s.slug));
  const subcategories = category.subcategories.map((sub) => {
    const subProducts = inCategory.filter((p) => p.subcategory === sub.slug);
    return {
      id: sub.id,
      slug: sub.slug,
      name: sub.name,
      anchorId: `${category.slug}-${sub.slug}`,
      productCount: subProducts.length,
      productIds: subProducts.map((p) => p.id), // exact render order
    };
  });
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    productCount: inCategory.length,
    subcategories,
    productsNotInAnySubcategory: inCategory.filter((p) => !knownSubs.has(p.subcategory)).map((p) => p.id),
  };
});

const ids = productRows.map((p) => Number(p.id));
const maxId = Math.max(...ids);
const idSet = new Set(ids);
const idGaps = [];
for (let i = 1; i <= maxId; i++) if (!idSet.has(i)) idGaps.push(i);

const oldPackRule = {
  unitsPerPack: pricing.UNITS_PER_PACK,
  packDiscount: pricing.PACK_DISCOUNT,
  note: "pack price = unitPrice * unitsPerPack - packDiscount; regular (struck-through) = unitPrice * unitsPerPack",
};

const body = {
  source: "src/data/products.ts, src/data/categories.ts, src/lib/pricing.ts @ tag baseline/pre-product-management",
  totals: {
    products: productRows.length,
    categories: categories.length,
    subcategories: categories.reduce((n, c) => n + c.subcategories.length, 0),
    outOfStockIds: productRows.filter((p) => !p.inStock).map((p) => p.id),
    productsWithDescription: productRows.filter((p) => p.description).length,
    maxId,
    idGaps,
    duplicateIds: ids.length - idSet.size,
  },
  oldPackRule,
  categories: tree,
  products: productRows,
};

const productsChecksum = createHash("sha256").update(JSON.stringify(productRows)).digest("hex");
const out = { ...body, productsChecksumSha256: productsChecksum };

const outPath = resolve(root, "tests", "baseline", "catalog.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`wrote ${outPath}`);
console.log(`products=${body.totals.products} categories=${body.totals.categories} subcategories=${body.totals.subcategories}`);
console.log(`per category: ${tree.map((c) => `${c.slug}=${c.productCount}`).join(", ")}`);
console.log(`id gaps: ${idGaps.join(",")}  duplicates: ${body.totals.duplicateIds}  out of stock: ${body.totals.outOfStockIds.join(",")}`);
console.log(`products not in any subcategory: ${tree.map((c) => c.productsNotInAnySubcategory.length).join("/")}`);
console.log(`checksum: ${productsChecksum}`);
