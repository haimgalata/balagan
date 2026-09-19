#!/usr/bin/env node
/**
 * Seed parity check (plan step 2 / section E): the LIVE database, as an anonymous
 * visitor sees it through get_storefront_catalog(), must equal the frozen
 * pre-migration baseline in tests/baseline/catalog.json — same product ids in the
 * same render order, same names/brands/placement, same prices, same stock state,
 * and the package option reproducing today's pack prices exactly (decision D2).
 *
 * Uses ONLY the public anon key (no logins, no writes, nothing modified).
 *
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_ANON_KEY="..."
 *   node scripts/verify-seed.mjs
 *
 * Exit code 0 = zero differences, 1 = differences found.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL_ = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const ANON = (process.env.SUPABASE_ANON_KEY ?? "").trim();
if (!URL_ || !ANON) { console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY."); process.exit(1); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(readFileSync(resolve(root, "tests/baseline/catalog.json"), "utf8"));

const headers = { apikey: ANON, "Content-Type": "application/json", ...(ANON.startsWith("eyJ") ? { Authorization: `Bearer ${ANON}` } : {}) };
const res = await fetch(`${URL_}/rest/v1/rpc/get_storefront_catalog`, { method: "POST", headers, body: "{}" });
const text = await res.text();
if (!res.ok) { console.error(`RPC failed: HTTP ${res.status} ${text.slice(0, 200)}`); process.exit(1); }
const live = JSON.parse(text);

const diffs = [];
const same = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${what}: live=${JSON.stringify(a)} baseline=${JSON.stringify(b)}`); };
const num = (what, a, b) => { if (!(typeof a === "number" || typeof a === "string") || Math.abs(Number(a) - Number(b)) > 1e-9) diffs.push(`${what}: live=${JSON.stringify(a)} baseline=${JSON.stringify(b)}`); };
let checks = 0;

// ---- category / subcategory tree: legacy ids, slugs, names, ORDER ----------------
same("category order (slugs)", live.categories.map((c) => c.slug), base.categories.map((c) => c.slug));
const seqDiff = (what, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const missing = b.filter((x) => !a.includes(x)), extra = a.filter((x) => !b.includes(x));
  diffs.push(`${what}: ${missing.length ? `missing [${missing.join(",")}] ` : ""}${extra.length ? `unexpected [${extra.join(",")}] ` : ""}${!missing.length && !extra.length ? "same members, different order" : ""}`.trim());
};
for (const bc of base.categories) {
  const lc = live.categories.find((c) => c.slug === bc.slug);
  if (!lc) { diffs.push(`category ${bc.slug} missing`); continue; }
  checks += 3;
  same(`category ${bc.slug} id`, lc.id, bc.id);
  same(`category ${bc.slug} name`, lc.name_he, bc.name);
  // subcategories without products are still listed by the RPC, exactly as categories.ts lists them
  seqDiff(`category ${bc.slug} subcategories`, lc.subcategories.map((s) => s.slug), bc.subcategories.map((s) => s.slug));
  for (const bs of bc.subcategories) {
    const ls = lc.subcategories.find((s) => s.slug === bs.slug);
    if (!ls) continue;
    checks += 2;
    same(`subcategory ${bc.slug}/${bs.slug} id`, ls.id, bs.id);
    same(`subcategory ${bc.slug}/${bs.slug} name`, ls.name_he, bs.name);
  }
}

// ---- products: same ids, same render order -------------------------------------------
const baselineOrder = base.categories.flatMap((c) => c.subcategories.flatMap((s) => s.productIds));
const liveOrder = live.products.map((p) => p.id);
same("product count", live.products.length, base.totals.products);
{
  // concise report instead of dumping two 141-id arrays
  const missing = baselineOrder.filter((id) => !liveOrder.includes(id));
  const extra = liveOrder.filter((id) => !baselineOrder.includes(id));
  if (missing.length) diffs.push(`product ids missing from live catalog: ${missing.join(",")}`);
  if (extra.length) diffs.push(`unexpected product ids in live catalog: ${extra.join(",")}`);
  if (!missing.length && !extra.length) {
    const i = baselineOrder.findIndex((id, k) => id !== liveOrder[k]);
    if (i >= 0) diffs.push(`render order differs starting at position ${i + 1}: live has id ${liveOrder[i]}, baseline has id ${baselineOrder[i]} (live ...${liveOrder.slice(Math.max(0, i - 1), i + 4).join(",")}... vs baseline ...${baselineOrder.slice(Math.max(0, i - 1), i + 4).join(",")}...)`);
  }
}
checks += 2;

// ---- per-product fields ------------------------------------------------------------------
const liveById = new Map(live.products.map((p) => [p.id, p]));
for (const bp of base.products) {
  const lp = liveById.get(bp.id);
  if (!lp) { diffs.push(`product ${bp.id} missing in live catalog`); continue; }
  const at = `product ${bp.id} (${bp.name})`;
  checks += 14;
  same(`${at} name`, lp.name_he, bp.name);
  same(`${at} brand`, lp.brand, bp.brand);
  same(`${at} category`, lp.category, bp.category);
  same(`${at} subcategory`, lp.subcategory, bp.subcategory);
  same(`${at} description`, lp.description, bp.description);
  same(`${at} image_path`, lp.image_path, null);
  same(`${at} name_en`, lp.name_en, null);
  num(`${at} unit price`, lp.unit?.price, bp.unitPrice);
  same(`${at} unit sale`, lp.unit?.sale_price, null);
  same(`${at} unit in_stock`, lp.unit?.in_stock, bp.inStock);
  if (!lp.package) { diffs.push(`${at} has no package option`); continue; }
  same(`${at} package label`, lp.package.label, "פקט");
  same(`${at} package unit_count`, lp.package.unit_count, 10);
  num(`${at} package regular (old struck-through pack price)`, lp.package.price, bp.oldPackRegular);
  num(`${at} package sale (old pack price customers paid)`, lp.package.sale_price, bp.oldPackPrice);
  same(`${at} package in_stock`, lp.package.in_stock, bp.inStock);
}

// ---- nothing private in the public payload ---------------------------------------------------
if (/"(barcode|unit_stock|package_stock|unit_track_stock|package_track_stock|unit_available|package_available|is_visible|sort_order|created_at|updated_at|user_id)"\s*:/.test(text)) diffs.push("public payload contains a private field");
checks += 1;

console.log(`baseline: ${base.totals.products} products, ${base.totals.categories} categories, ${base.totals.subcategories} subcategories (checksum ${base.productsChecksumSha256.slice(0, 12)}…)`);
console.log(`live:     ${live.products.length} products, ${live.categories.length} categories, ${live.categories.reduce((n, c) => n + c.subcategories.length, 0)} subcategories`);
console.log(`per category live: ${live.categories.map((c) => `${c.slug}=${live.products.filter((p) => p.category === c.slug).length}`).join(", ")}`);
if (diffs.length) {
  console.log(`\n${diffs.length} DIFFERENCE(S) (first 25):\n - ` + diffs.slice(0, 25).join("\n - "));
  process.exit(1);
}
console.log(`\n${checks} comparisons, 0 differences — live database == pre-migration baseline.`);
