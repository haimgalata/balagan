/**
 * Pre-migration baseline: saved-cart fixtures for the OLD cart model.
 *
 * Writes tests/baseline/cart-legacy-fixtures.json — a list of raw
 * `localStorage["balagan_cart"]` payloads plus what the OLD app (single
 * total-units quantity per product, packs auto-derived, see
 * src/context/CartContext.tsx + src/lib/pricing.ts @ baseline tag) is
 * expected to show for each. After the cart model changes, the same payloads
 * are replayed against the new code to verify migration (units stay units,
 * nothing deleted, totals re-priced, one-time notice when a total changes).
 *
 * `sanitizeOld` below is a verbatim port of `sanitizeCartItems` from
 * CartContext.tsx (that file imports React, so it can't be loaded by plain
 * Node). The browser run in tests/baseline/cart-legacy-observed.json
 * cross-checks that this port matches the real app.
 *
 * Run from the repo root:  node --no-warnings scripts/baseline/capture-cart-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { products } = await import(new URL("../../seed-data/products.ts", import.meta.url));
const { UNITS_PER_PACK, getPriceBreakdown } = await import(new URL("../legacy/old-pricing.mjs", import.meta.url));

const byId = new Map(products.map((p) => [p.id, p]));

/** Verbatim port of sanitizeCartItems (src/context/CartContext.tsx). */
function sanitizeOld(raw) {
  if (!Array.isArray(raw)) return [];
  const totals = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry.productId !== "string") continue;
    if (!products.some((product) => product.id === entry.productId)) continue;
    const rawQuantity = typeof entry.quantity === "number" ? Math.floor(entry.quantity) : 0;
    if (rawQuantity <= 0) continue;
    const units = entry.type === "pack" ? rawQuantity * UNITS_PER_PACK : rawQuantity;
    totals.set(entry.productId, (totals.get(entry.productId) ?? 0) + units);
  }
  return Array.from(totals.entries()).map(([productId, quantity]) => ({ productId, quantity }));
}

/** What the old app computes for a stored payload (same steps as useLocalStorage + CartProvider). */
function expectedOld(storageValue) {
  let parsed;
  try {
    parsed = JSON.parse(storageValue);
  } catch {
    parsed = []; // useLocalStorage falls back to the initial value on parse errors
  }
  const items = sanitizeOld(parsed);
  const lines = items.map(({ productId, quantity }) => {
    const p = byId.get(productId);
    const b = getPriceBreakdown(p.unitPrice, quantity);
    return {
      productId,
      name: p.name,
      unitPrice: p.unitPrice,
      inStock: p.inStock,
      totalUnits: quantity,
      packs: b.packs,
      remainingUnits: b.remainingUnits,
      packPrice: b.packPrice,
      discount: b.discount,
      lineTotal: b.finalTotal,
    };
  });
  return {
    lines,
    totalCount: lines.reduce((n, l) => n + l.totalUnits, 0),
    totalPrice: lines.reduce((n, l) => n + l.lineTotal, 0),
  };
}

const outOfStockId = products.find((p) => !p.inStock).id;
const tobaccoId = products.find((p) => p.category === "tobacco").id;

const raw = [
  ["empty", "Empty cart array", JSON.stringify([])],
  ["one-unit", "1 unit of id 1 — no pack involved, total must not change", JSON.stringify([{ productId: "1", quantity: 1 }])],
  ["nine-units", "9 units — one short of a pack", JSON.stringify([{ productId: "1", quantity: 9 }])],
  ["ten-units", "10 units — old model auto-applied the pack (₪500); new model prices as 10 units (₪510)", JSON.stringify([{ productId: "1", quantity: 10 }])],
  ["twenty-three-units", "23 units — 2 auto packs + 3 units in the old model", JSON.stringify([{ productId: "1", quantity: 23 }])],
  [
    "multi-product",
    "Several products incl. an out-of-stock one and a tobacco product",
    JSON.stringify([
      { productId: "1", quantity: 12 },
      { productId: "2", quantity: 3 },
      { productId: outOfStockId, quantity: 1 },
      { productId: tobaccoId, quantity: 10 },
    ]),
  ],
  [
    "legacy-pack-shape",
    "Ancient per-line-type shape: a `pack` line counted PACKS (×10 units), old sanitizer expands it",
    JSON.stringify([
      { productId: "1", type: "pack", quantity: 2 },
      { productId: "2", type: "unit", quantity: 3 },
    ]),
  ],
  ["unknown-product-id", "Contains an id that is not in the catalog (old app drops it)", JSON.stringify([{ productId: "9999", quantity: 2 }, { productId: "1", quantity: 1 }])],
  [
    "bad-quantities",
    "Zero, negative, string and fractional quantities",
    JSON.stringify([
      { productId: "1", quantity: 0 },
      { productId: "2", quantity: -3 },
      { productId: "4", quantity: "5" },
      { productId: "5", quantity: 2.7 },
    ]),
  ],
  ["duplicate-lines", "Same product twice — old sanitizer merges into 12 units", JSON.stringify([{ productId: "1", quantity: 4 }, { productId: "1", quantity: 8 }])],
  ["not-an-array", "Valid JSON but not an array", JSON.stringify({ productId: "1", quantity: 3 })],
  ["corrupt-json", "Unparseable string in storage", "{not json"],
];

const fixtures = raw.map(([name, description, storageValue]) => ({
  name,
  description,
  storageKey: "balagan_cart",
  storageValue,
  expectedOld: expectedOld(storageValue),
}));

const out = {
  note: "Old-model expectations computed from src/lib/pricing.ts + a verbatim port of sanitizeCartItems at tag baseline/pre-product-management. Observed app behavior is in cart-legacy-observed.json.",
  fixtures,
};

const outPath = resolve(root, "tests", "baseline", "cart-legacy-fixtures.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`wrote ${outPath}`);
for (const f of fixtures) {
  console.log(`${f.name.padEnd(20)} lines=${f.expectedOld.lines.length} count=${f.expectedOld.totalCount} total=₪${f.expectedOld.totalPrice}`);
}
