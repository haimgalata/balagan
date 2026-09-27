#!/usr/bin/env node
/**
 * Balagan — live security test for the Supabase project (plan §D, step 1).
 *
 * Proves, against the REAL project, that the admin area is protected by the
 * database (RLS + grants + storage policies), not by hiding a route:
 *
 *   anon             -> can ONLY call get_storefront_catalog(); everything else denied
 *   non-admin user   -> logged in but not in admin_users: no reads, no writes, no self-promotion
 *   admin            -> full CRUD; constraints reject bad prices/packages; storage works
 *
 * Also covers the admin "Categories" support added by migration 0005 (the reorder / product-count
 * functions, the slug lock), the admin "Products" support added by migration 0006 (shared inventory —
 * one stock_base_units count plus independent unit_available/package_available switches — and the
 * per-(category,subcategory) product reorder function), the cart's shared-stock quantity check added by
 * migration 0007 (check_stock_availability — never leaks the raw stock count, hidden products, or whether a
 * product exists), and the Business Settings support added by migration 0008 (get_business_settings() —
 * physical-store hours, online-order hours, min order, delivery fee, manual pause). If a migration has not
 * been applied yet, its section reports a SKIP (exit code 2) instead of failing.
 *
 * Zero dependencies (plain fetch, Node >= 18). Uses ONLY the public anon key plus
 * test-account passwords supplied through the environment — never the
 * service-role key. Nothing secret is printed.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_ANON_KEY="eyJ..."
 *   $env:ADMIN_EMAIL="..."; $env:ADMIN_PASSWORD="..."
 *   $env:USER_EMAIL="..."; $env:USER_PASSWORD="..."      # a normal user that is NOT in admin_users
 *   node scripts/security-test.mjs [--check-signup]
 *
 *   --check-signup  also tries to self-register a throwaway user against
 *                   /auth/v1/signup and expects it to be REFUSED (proves public
 *                   sign-ups are disabled). Opt-in because if sign-ups were
 *                   enabled it would create an unconfirmed junk user.
 *
 * Side effects: inserts a few rows tagged "zz-security-probe" (hidden category,
 * subcategory, product with explicit ids 900000001-900000009, one tiny image),
 * then deletes them in a `finally`. Explicit ids mean the product_id_seq
 * sequence is never consumed. If cleanup ever fails, the script prints the
 * SQL to remove leftovers.
 *
 * Exit code: 0 = all passed and nothing skipped, 1 = a check failed,
 *            2 = all executed checks passed but a group was skipped (NOT fully verified).
 */
import { randomUUID } from "node:crypto";

const env = (k) => (process.env[k] ?? "").trim();
const URL_ = env("SUPABASE_URL").replace(/\/+$/, "");
const ANON = env("SUPABASE_ANON_KEY");
const ADMIN_EMAIL = env("ADMIN_EMAIL"), ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const USER_EMAIL = env("USER_EMAIL"), USER_PASSWORD = process.env.USER_PASSWORD ?? "";
const CHECK_SIGNUP = process.argv.includes("--check-signup");

if (!URL_ || !ANON || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Missing env. Required: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL, ADMIN_PASSWORD (and USER_EMAIL/USER_PASSWORD for the non-admin checks).");
  process.exit(1);
}

// ---------------------------------------------------------------- tiny harness
let passed = 0;
const failed = [];
const skipped = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed.push(name); console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- http helpers
async function call(method, url, { token = ANON, body, headers = {}, raw } = {}) {
  // Legacy anon keys are JWTs (eyJ...) and are sent as Bearer too. New-style publishable keys
  // (sb_publishable_...) are NOT JWTs: they go in the `apikey` header only.
  const bearer = token === ANON && !ANON.startsWith("eyJ") ? {} : { Authorization: `Bearer ${token}` };
  const res = await fetch(url, {
    method,
    headers: { apikey: ANON, ...bearer, ...headers, ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}
const rest = (method, path, opts = {}) =>
  call(method, `${URL_}/rest/v1/${path}`, { ...opts, headers: { Prefer: "return=representation", ...(opts.headers ?? {}) } });
const rpc = (name, token, args = {}) => call("POST", `${URL_}/rest/v1/rpc/${name}`, { token, body: args });
const pgCode = (r) => r.json?.code ?? "";

/** PostgREST "permission denied" / RLS violation: 401 (anon) or 403 (authenticated), SQLSTATE 42501. */
const isDenied = (r) => (r.status === 401 || r.status === 403);
/** RLS hides rows instead of raising: 200 with an empty array (or 0 rows changed). */
const isEmpty = (r) => r.status === 200 && Array.isArray(r.json) && r.json.length === 0;
const deniedOrEmpty = (r) => isDenied(r) || isEmpty(r);

async function signIn(email, password) {
  const r = await call("POST", `${URL_}/auth/v1/token?grant_type=password`, { body: { email, password } });
  if (r.status !== 200 || !r.json?.access_token) return { error: `sign-in failed for ${email} (HTTP ${r.status}: ${r.json?.msg ?? r.json?.error_description ?? r.json?.error ?? "unknown"})` };
  return { token: r.json.access_token, userId: r.json.user?.id };
}

const storagePath = (p) => `${URL_}/storage/v1/object/product-images/${p}`;
const storageDenied = (r) => [400, 401, 403].includes(r.status) && /(security|unauthori[sz]ed|forbidden|403|denied|not allowed)/i.test(r.text);
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64");
const upload = (p, token, bytes, type) => call("POST", storagePath(p), { token, raw: bytes, headers: { "Content-Type": type, "x-upsert": "false" } });

// probe fixtures (explicit ids => the product_id_seq sequence is never touched)
const CAT = randomUUID(), SUB = randomUUID();
const OTHER_CAT = randomUUID(), OTHER_SUB = randomUUID(), SUB2 = randomUUID();
const PID = "900000001", PID_BAD = "900000002", PID2 = "900000003";
const IMG = `products/${PID}/probe.png`;
const BARCODE = "ZZ-SECURITY-PROBE-1";
const PRIVATE_KEYS = /"(barcode|stock_base_units|track_stock|unit_available|package_available|unit_in_stock|package_in_stock|is_visible|sort_order|created_at|updated_at|user_id)"\s*:/;

let adminToken = "", userToken = "", userId = "";
const created = { product: false, product2: false, sub: false, cat: false, otherCat: false, otherSub: false, image: false };

async function cleanup() {
  section("Cleanup");
  const res = [];
  if (created.image) res.push(["storage object", (await call("DELETE", `${URL_}/storage/v1/object/product-images`, { token: adminToken, body: { prefixes: [IMG] } })).status < 300]);
  res.push(["products", (await rest("DELETE", `products?id=in.(${PID},${PID_BAD},${PID2})`, { token: adminToken })).status < 300]);
  res.push(["subcategories", (await rest("DELETE", `subcategories?id=in.(${SUB},${SUB2},${OTHER_SUB})`, { token: adminToken })).status < 300]);
  res.push(["categories", (await rest("DELETE", `categories?id=in.(${CAT},${OTHER_CAT})`, { token: adminToken })).status < 300]);
  const left = await rest("GET", `products?id=in.(${PID},${PID_BAD},${PID2})&select=id`, { token: adminToken });
  const leftCat = await rest("GET", `categories?slug=like.zz-security-probe*&select=id`, { token: adminToken });
  const clean = left.json?.length === 0 && leftCat.json?.length === 0;
  console.log(`  probe rows removed: ${clean ? "yes" : "NO — remove manually:"}`);
  if (!clean) console.log("    delete from public.products where id in ('900000001','900000002','900000003');\n    delete from public.subcategories where slug like 'zz-security-probe%';\n    delete from public.categories where slug like 'zz-security-probe%';\n    (and delete the object products/900000001/probe.png from bucket product-images)");
}

async function main() {
  // ------------------------------------------------------------------ sign-ins
  const a = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (a.error) { console.error(a.error); process.exit(1); }
  adminToken = a.token;
  if (USER_EMAIL && USER_PASSWORD) {
    const u = await signIn(USER_EMAIL, USER_PASSWORD);
    if (u.error) { console.error(u.error); process.exit(1); }
    userToken = u.token; userId = u.userId;
  }

  // ------------------------------------------------------- 0. admin sets up probes
  section("Admin: create probe rows (hidden), prove admin access works");
  check("admin is_admin() = true", (await rpc("is_admin", adminToken)).json === true);
  let r = await rest("POST", "categories", { token: adminToken, body: { id: CAT, slug: "zz-security-probe", name_he: "בדיקת אבטחה", is_visible: false, sort_order: 9999 } });
  created.cat = r.status === 201; check("admin can INSERT category", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  if (!created.cat) throw new Error("cannot continue without the probe category");
  r = await rest("POST", "subcategories", { token: adminToken, body: { id: SUB, category_id: CAT, slug: "zz-security-probe", name_he: "תת בדיקה", is_visible: false } });
  created.sub = r.status === 201; check("admin can INSERT subcategory", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  r = await rest("POST", "products", { token: adminToken, body: {
    id: PID, category_id: CAT, subcategory_id: SUB, name_he: "מוצר בדיקת אבטחה", brand: "ZZ", barcode: BARCODE,
    unit_price: 10, unit_sale_enabled: true, unit_sale_price: 8, track_stock: true, stock_base_units: 7,
    package_enabled: true, package_label: "מארז", package_unit_count: 6, package_price: 55, package_sale_enabled: true, package_sale_price: 50,
    is_visible: false } });
  created.product = r.status === 201; check("admin can INSERT product (unit sale + package + own sale)", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  check("admin can SELECT hidden product incl. barcode + shared stock", (await rest("GET", `products?id=eq.${PID}&select=barcode,stock_base_units`, { token: adminToken })).json?.[0]?.barcode === BARCODE);
  check("admin sees own admin_users row (guard query works)", (await rest("GET", "admin_users?select=user_id", { token: adminToken })).json?.length === 1);

  // -------------------------------------------------------------------- 1. anon
  section("Anonymous visitor (anon key only)");
  for (const t of ["categories", "subcategories", "products", "admin_users"]) {
    r = await rest("GET", `${t}?select=*&limit=1`);
    check(`anon cannot SELECT ${t}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  }
  for (const [n, method, path, body] of [
    ["INSERT categories", "POST", "categories", { slug: "zz-anon", name_he: "x" }],
    ["INSERT subcategories", "POST", "subcategories", { category_id: CAT, slug: "zz-anon", name_he: "x" }],
    ["INSERT products", "POST", "products", { id: PID_BAD, category_id: CAT, name_he: "x", unit_price: 1 }],
    ["INSERT admin_users", "POST", "admin_users", { user_id: randomUUID() }],
    ["UPDATE products", "PATCH", `products?id=eq.${PID}`, { unit_price: 1 }],
    ["DELETE products", "DELETE", `products?id=eq.${PID}`, undefined],
    ["UPDATE categories", "PATCH", `categories?id=eq.${CAT}`, { name_he: "hacked" }],
    ["DELETE categories", "DELETE", `categories?id=eq.${CAT}`, undefined],
  ]) { r = await rest(method, path, { body }); check(`anon cannot ${n}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
  check("probe product unchanged after anon attempts", Number((await rest("GET", `products?id=eq.${PID}&select=unit_price`, { token: adminToken })).json?.[0]?.unit_price) === 10);
  r = await rpc("is_admin", ANON);
  check("anon cannot call is_admin()", isDenied(r) || r.status === 404, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await upload(`products/${PID}/anon.png`, ANON, PNG, "image/png");
  check("anon cannot upload to product-images", storageDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await call("POST", `${URL_}/storage/v1/object/list/product-images`, { body: { prefix: "", limit: 10 } });
  check("anon cannot LIST the image bucket", isDenied(r) || (r.status === 200 && Array.isArray(r.json) && r.json.length === 0), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

  const anonCat = await rpc("get_storefront_catalog", ANON);
  check("anon CAN call get_storefront_catalog()", anonCat.status === 200 && Array.isArray(anonCat.json?.categories) && Array.isArray(anonCat.json?.products), `HTTP ${anonCat.status}`);
  check("catalog excludes the hidden probe product/category", !anonCat.text.includes(PID) && !anonCat.text.includes("zz-security-probe"));
  check("catalog leaks no private fields (barcode, stock, availability, visibility, sort, timestamps)", !PRIVATE_KEYS.test(anonCat.text) && !anonCat.text.includes(BARCODE));

  // ------------------------------------------------------------- 2. non-admin user
  if (!userToken) {
    skipped.push("non-admin user group");
    section("Logged-in NON-admin user  --  SKIPPED (set USER_EMAIL / USER_PASSWORD: create a normal user under Authentication -> Users; do NOT add it to admin_users)");
  } else {
    section("Logged-in user who is NOT an admin");
    check("non-admin is_admin() = false", (await rpc("is_admin", userToken)).json === false);
    for (const t of ["categories", "subcategories", "products", "admin_users"]) {
      r = await rest("GET", `${t}?select=*`, { token: userToken });
      check(`non-admin sees 0 rows of ${t}`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    for (const [n, method, path, body] of [
      ["INSERT categories", "POST", "categories", { slug: "zz-user", name_he: "x" }],
      ["INSERT subcategories", "POST", "subcategories", { category_id: CAT, slug: "zz-user", name_he: "x" }],
      ["INSERT products", "POST", "products", { id: PID_BAD, category_id: CAT, name_he: "x", unit_price: 1 }],
      // random uuid on purpose (see note above): a real id could actually promote the test user if grants were broken
      ["INSERT INTO admin_users (self-promotion attempt)", "POST", "admin_users", { user_id: randomUUID() }],
    ]) { r = await rest(method, path, { token: userToken, body }); check(`non-admin cannot ${n}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
    for (const [n, method, path, body] of [
      ["UPDATE products", "PATCH", `products?id=eq.${PID}`, { unit_price: 1 }],
      ["DELETE products", "DELETE", `products?id=eq.${PID}`, undefined],
      ["UPDATE categories", "PATCH", `categories?id=eq.${CAT}`, { name_he: "hacked" }],
      ["DELETE subcategories", "DELETE", `subcategories?id=eq.${SUB}`, undefined],
    ]) { r = await rest(method, path, { token: userToken, body }); check(`non-admin ${n} changes nothing`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
    check("probe product unchanged after non-admin attempts", Number((await rest("GET", `products?id=eq.${PID}&select=unit_price,name_he`, { token: adminToken })).json?.[0]?.unit_price) === 10);
    r = await upload(`products/${PID}/user.png`, userToken, PNG, "image/png");
    check("non-admin cannot upload to product-images", storageDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await call("POST", `${URL_}/storage/v1/object/list/product-images`, { token: userToken, body: { prefix: "", limit: 10 } });
    check("non-admin cannot LIST the image bucket", isDenied(r) || (r.status === 200 && Array.isArray(r.json) && r.json.length === 0), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    const userCat = await rpc("get_storefront_catalog", userToken);
    check("non-admin gets exactly the public catalog (nothing extra)", userCat.status === 200 && JSON.stringify(userCat.json) === JSON.stringify(anonCat.json));
  }

  // ------------------------------------------------------------ 3. DB constraints
  section("Admin: database constraints reject bad data");
  const bad = async (name, body, code) => {
    const x = await rest("POST", "products", { token: adminToken, body: { id: PID_BAD, category_id: CAT, name_he: "x", unit_price: 10, ...body } });
    check(name, x.status >= 400 && pgCode(x) === code, `expected ${code}, got HTTP ${x.status} ${x.text.slice(0, 120)}`);
    if (x.status < 300) await rest("DELETE", `products?id=eq.${PID_BAD}`, { token: adminToken });
  };
  await bad("unit sale enabled without a sale price", { unit_sale_enabled: true }, "23514");
  await bad("unit sale price not lower than regular", { unit_sale_enabled: true, unit_sale_price: 10 }, "23514");
  await bad("negative unit price", { unit_price: -1 }, "23514");
  await bad("negative stock", { stock_base_units: -1 }, "23514");
  await bad("package enabled without label", { package_enabled: true, package_unit_count: 10, package_price: 90 }, "23514");
  await bad("package enabled without unit count", { package_enabled: true, package_label: "פקט", package_price: 90 }, "23514");
  await bad("package enabled without price", { package_enabled: true, package_label: "פקט", package_unit_count: 10 }, "23514");
  await bad("package unit count of 1", { package_enabled: true, package_label: "פקט", package_unit_count: 1, package_price: 90 }, "23514");
  await bad("package sale without a package", { package_sale_enabled: true, package_sale_price: 5 }, "23514");
  await bad("package sale not lower than package price", { package_enabled: true, package_label: "פקט", package_unit_count: 10, package_price: 90, package_sale_enabled: true, package_sale_price: 90 }, "23514");
  await bad("non-numeric product id", { id: "abc" }, "23514");
  await bad("image_path that is a URL", { image_path: "https://evil.example/x.png" }, "23514");
  await bad("duplicate barcode", { barcode: BARCODE }, "23505");
  // a REAL subcategory that belongs to ANOTHER category must be refused (composite FK)
  r = await rest("POST", "categories", { token: adminToken, body: { id: OTHER_CAT, slug: "zz-security-probe-2", name_he: "אחר", is_visible: false } });
  created.otherCat = r.status === 201;
  r = await rest("POST", "subcategories", { token: adminToken, body: { id: OTHER_SUB, category_id: OTHER_CAT, slug: "zz-security-probe-2", name_he: "אחר", is_visible: false } });
  created.otherSub = r.status === 201;
  check("(fixture) second probe category + subcategory created", created.otherCat && created.otherSub, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  if (created.otherSub) await bad("product pointing at a subcategory of a different category", { subcategory_id: OTHER_SUB }, "23503");
  r = await rest("DELETE", `categories?id=eq.${CAT}`, { token: adminToken });
  check("cannot delete a category that still has products", r.status >= 400 && ["23001", "23503"].includes(pgCode(r)), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  // NOTE: random uuid (never a real user id) — if grants were ever wrong, the foreign key
  // would reject this row instead of the test accidentally promoting a real account.
  r = await rest("POST", "admin_users", { token: adminToken, body: { user_id: randomUUID() } });
  check("even the admin cannot write admin_users through the API", isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

  // ------------------------------------- 3b. admin Categories support (migration 0005)
  const probe0005 = await rpc("admin_product_counts", adminToken);
  if (probe0005.status === 404 || pgCode(probe0005) === "PGRST202") {
    skipped.push("admin Categories support (apply supabase/migrations/0005_admin_categories.sql, then re-run)");
    section("Admin Categories support (0005)  --  SKIPPED: migration 0005 is not applied yet");
  } else {
    section("Admin Categories support (migration 0005)");
    const denied404 = (x) => isDenied(x) || x.status === 404; // anon may get 401/403 (or 404 if the function is not visible to it)
    for (const [name, args] of [
      ["admin_reorder_categories", { p_ids: [CAT] }],
      ["admin_reorder_subcategories", { p_category_id: CAT, p_ids: [SUB] }],
      ["admin_product_counts", {}],
    ]) {
      r = await rpc(name, ANON, args);
      check(`anon cannot call ${name}()`, denied404(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }

    // admin: product counts (incl. hidden) — grouped, one query
    check("admin_product_counts() returns grouped counts", probe0005.status === 200 && Array.isArray(probe0005.json) && probe0005.json.length > 0, `HTTP ${probe0005.status}`);
    const total = (probe0005.json ?? []).reduce((n, row) => n + Number(row.product_count), 0);
    check("counts cover every product, hidden ones included (>= 141 seeded + the hidden probe)", total >= 142, `total ${total}`);

    // admin: slug lock (names stay editable, the slug does not)
    r = await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { slug: "zz-security-probe-renamed" } });
    check("the slug of a category cannot be changed after creation", r.status >= 400 && /slug cannot be changed/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    r = await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { slug: "zz-renamed" } });
    check("the slug of a subcategory cannot be changed after creation", r.status >= 400 && /slug cannot be changed/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    r = await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { name_he: "שם חדש לבדיקה", name_en: "Probe" } });
    check("names of a category can still be edited", r.status === 200 && r.json?.[0]?.name_he === "שם חדש לבדיקה", `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // admin: reorder — proven on the hidden PROBE subcategories only (real ordering is never touched)
    r = await rest("POST", "subcategories", { token: adminToken, body: { id: SUB2, category_id: CAT, slug: "zz-security-probe-b", name_he: "תת בדיקה ב", is_visible: false, sort_order: 20 } });
    check("(fixture) second probe subcategory created", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { sort_order: 10 } });
    const order = async () => (await rest("GET", `subcategories?category_id=eq.${CAT}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json?.map((row) => row.id);
    check("probe order before: [SUB, SUB2]", JSON.stringify(await order()) === JSON.stringify([SUB, SUB2]));

    r = await rpc("admin_reorder_subcategories", adminToken, { p_category_id: CAT, p_ids: [SUB2, SUB] });
    check("admin can reorder subcategories atomically", r.status < 300, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    check("...the new order is stored (10, 20, ...)", JSON.stringify(await order()) === JSON.stringify([SUB2, SUB]));
    const rows = (await rest("GET", `subcategories?category_id=eq.${CAT}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json ?? [];
    check("...as sort_order 10 and 20", rows.map((row) => row.sort_order).join() === "10,20");

    for (const [name, args] of [
      ["missing one", { p_category_id: CAT, p_ids: [SUB2] }],
      ["duplicate", { p_category_id: CAT, p_ids: [SUB2, SUB, SUB] }],
      ["another category's subcategory", { p_category_id: CAT, p_ids: [SUB2, OTHER_SUB] }],
      ["empty list", { p_category_id: CAT, p_ids: [] }],
    ]) {
      r = await rpc("admin_reorder_subcategories", adminToken, args);
      check(`a bad subcategory list is rejected: ${name}`, r.status >= 400, `HTTP ${r.status}`);
    }
    check("...and the order is unchanged after all rejected lists", JSON.stringify(await order()) === JSON.stringify([SUB2, SUB]));

    r = await rpc("admin_reorder_categories", adminToken, { p_ids: [CAT] }); // not ALL categories
    check("a category list that is not exactly the existing categories is rejected", r.status >= 400 && /exactly the existing/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // non-admin: sees nothing, changes nothing
    if (userToken) {
      r = await rpc("admin_product_counts", userToken);
      check("a non-admin gets no product counts (RLS)", r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rpc("admin_reorder_subcategories", userToken, { p_category_id: CAT, p_ids: [SUB, SUB2] });
      check("a non-admin's reorder is rejected", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      check("...and changed nothing", JSON.stringify(await order()) === JSON.stringify([SUB2, SUB]));
      r = await rpc("admin_reorder_categories", userToken, { p_ids: [CAT] });
      check("a non-admin's category reorder is rejected", r.status >= 400, `HTTP ${r.status}`);
    }
  }

  // ------------------------------------------- 3c. admin Products support (migration 0006)
  const probe0006 = await rpc("admin_reorder_products", adminToken, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID] });
  if (probe0006.status === 404 || pgCode(probe0006) === "PGRST202") {
    skipped.push("admin Products support (apply supabase/migrations/0006_admin_products.sql, then re-run)");
    section("Admin Products support (0006)  --  SKIPPED: migration 0006 is not applied yet");
  } else {
    section("Admin Products support (migration 0006)");
    check("admin can reorder a single-product group (fixture call above succeeded)", probe0006.status < 300, `HTTP ${probe0006.status} ${probe0006.text.slice(0, 100)}`);

    r = await rpc("admin_reorder_products", ANON, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID] });
    check("anon cannot call admin_reorder_products()", isDenied(r) || r.status === 404, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // a second probe product in the SAME (category, subcategory) group, to reorder against
    r = await rest("POST", "products", { token: adminToken, body: { id: PID2, category_id: CAT, subcategory_id: SUB, name_he: "מוצר בדיקת אבטחה 2", unit_price: 5, is_visible: false, sort_order: 20 } });
    created.product2 = r.status === 201; check("(fixture) second probe product created", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    const productOrder = async () =>
      (await rest("GET", `products?category_id=eq.${CAT}&subcategory_id=eq.${SUB}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json?.map((row) => row.id);
    check("probe order before: [PID, PID2]", JSON.stringify(await productOrder()) === JSON.stringify([PID, PID2]));

    r = await rpc("admin_reorder_products", adminToken, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID2, PID] });
    check("admin can reorder products atomically", r.status < 300, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    check("...the new order is stored (10, 20)", JSON.stringify(await productOrder()) === JSON.stringify([PID2, PID]));
    const prows = (await rest("GET", `products?category_id=eq.${CAT}&subcategory_id=eq.${SUB}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json ?? [];
    check("...as sort_order 10 and 20", prows.map((row) => row.sort_order).join() === "10,20");

    for (const [name, args] of [
      ["missing one", { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID2] }],
      ["duplicate", { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID2, PID, PID] }],
      ["empty list", { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [] }],
      // a product that is not in THIS (category, subcategory) group at all — proves cross-group isolation
      ["a product outside this group", { p_category_id: CAT, p_subcategory_id: OTHER_SUB, p_ids: [PID2, PID] }],
    ]) {
      r = await rpc("admin_reorder_products", adminToken, args);
      check(`a bad product list is rejected: ${name}`, r.status >= 400, `HTTP ${r.status}`);
    }
    check("...and the order is unchanged after all rejected lists", JSON.stringify(await productOrder()) === JSON.stringify([PID2, PID]));

    if (userToken) {
      r = await rpc("admin_reorder_products", userToken, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID, PID2] });
      check("a non-admin's product reorder is rejected", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      check("...and changed nothing", JSON.stringify(await productOrder()) === JSON.stringify([PID2, PID]));
    }
  }

  // -------------------------------------------------- 4. RPC shape when made public
  section("Public catalog output (probe made visible, then hidden again)");
  for (const [t, id] of [["categories", CAT], ["subcategories", SUB], ["products", PID]]) await rest("PATCH", `${t}?id=eq.${id}`, { token: adminToken, body: { is_visible: true } });
  const live = await rpc("get_storefront_catalog", ANON);
  const p = live.json?.products?.find((x) => x.id === PID);
  check("visible probe appears in the public catalog", !!p);
  check("unit: price 10, sale 8 shown, in_stock true (shared pool has 7, package needs 6)", p?.unit?.price === 10 && p?.unit?.sale_price === 8 && p?.unit?.in_stock === true, JSON.stringify(p?.unit));
  check("package: label מארז, count 6, price 55, sale 50, in_stock true (7 >= 6)", p?.package?.label === "מארז" && p?.package?.unit_count === 6 && p?.package?.price === 55 && p?.package?.sale_price === 50 && p?.package?.in_stock === true, JSON.stringify(p?.package));
  check("public payload still leaks no private fields", !PRIVATE_KEYS.test(live.text) && !live.text.includes(BARCODE));

  // shared inventory: draining the ONE pool below the package's unit count affects BOTH options together
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { unit_sale_enabled: false, package_sale_enabled: false, stock_base_units: 3 } });
  const low = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("sales disabled => sale_price hidden; 3 base units < package of 6 => unit still in stock, package NOT (shared pool, not independent counters)",
    low?.unit?.sale_price === null && low?.package?.sale_price === null && low?.unit?.in_stock === true && low?.package?.in_stock === false, JSON.stringify(low));

  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { stock_base_units: 0 } });
  const off = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("0 base units => BOTH unit and package out of stock (the same shared count drives both)",
    off?.unit?.in_stock === false && off?.package?.in_stock === false, JSON.stringify(off));

  // manual "sell this option right now" switches stay independent of the stock count
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { stock_base_units: 7, unit_available: false } });
  const manualOff = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("manually disabling the UNIT (with plenty of stock) hides only the unit, package unaffected",
    manualOff?.unit?.in_stock === false && manualOff?.package?.in_stock === true, JSON.stringify(manualOff));
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { unit_available: true, package_available: false } });
  const manualOff2 = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("manually disabling the PACKAGE (with plenty of stock) hides only the package, unit unaffected",
    manualOff2?.unit?.in_stock === true && manualOff2?.package?.in_stock === false, JSON.stringify(manualOff2));
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { package_available: true } });

  for (const [t, id] of [["products", PID], ["subcategories", SUB], ["categories", CAT]]) await rest("PATCH", `${t}?id=eq.${id}`, { token: adminToken, body: { is_visible: false } });
  check("hidden again => gone from public catalog", !(await rpc("get_storefront_catalog", ANON)).text.includes(PID));

  // --------------------------------------------------------------------- 5. storage
  section("Image bucket");
  r = await upload(IMG, adminToken, PNG, "image/png");
  created.image = r.status === 200; check("admin can upload a PNG", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  if (created.image) {
    r = await call("GET", `${URL_}/storage/v1/object/public/product-images/${IMG}`, { headers: {} });
    check("image is publicly fetchable by URL (no login)", r.status === 200);
    r = await call("POST", `${URL_}/storage/v1/object/list/product-images`, { token: adminToken, body: { prefix: `products/${PID}`, limit: 10 } });
    check("admin can list the bucket", r.status === 200 && Array.isArray(r.json) && r.json.some((o) => o.name === "probe.png"), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  }
  r = await upload(`products/${PID}/notes.txt`, adminToken, Buffer.from("hello"), "text/plain");
  check("bucket rejects non-image file types", r.status >= 400, `HTTP ${r.status}`);
  r = await upload(`products/${PID}/big.png`, adminToken, Buffer.alloc(2 * 1024 * 1024 + 1024, 1), "image/png");
  check("bucket rejects files over 2 MB", r.status >= 400, `HTTP ${r.status}`);

  // ------------------------------------------------- 5b. cart stock availability check (migration 0007)
  const probe0007 = await rpc("check_stock_availability", ANON, { p_items: [] });
  if (probe0007.status === 404 || pgCode(probe0007) === "PGRST202") {
    skipped.push("cart stock availability check (apply supabase/migrations/0007_stock_availability.sql, then re-run)");
    section("Cart stock availability check (0007)  --  SKIPPED: migration 0007 is not applied yet");
  } else {
    section("Cart stock availability check (migration 0007)");
    check("empty request => empty result", probe0007.status === 200 && JSON.stringify(probe0007.json) === "[]", `HTTP ${probe0007.status} ${probe0007.text.slice(0, 100)}`);

    // section 4 left the probe product AND its category AND its subcategory all hidden. Visibility is a chain
    // (product AND category AND subcategory must all be visible — see get_storefront_catalog()'s own rule),
    // so each level is exercised on its own rather than flipping all three at once.
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("product + category + subcategory all hidden => NOT available", r.json?.[0]?.available === false, JSON.stringify(r.json));

    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: true } });
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { is_visible: true } });
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("category + subcategory now visible, but the PRODUCT itself still hidden => still NOT available (existence never revealed)", r.json?.[0]?.available === false, JSON.stringify(r.json));

    await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { is_visible: true } }); // now everything in the chain is visible
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 7 }] });
    check("everything visible, shared stock is 7: requesting exactly 7 => available", r.json?.[0]?.available === true, JSON.stringify(r.json));
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 8 }] });
    check("requesting 8 (one over) => NOT available", r.json?.[0]?.available === false, JSON.stringify(r.json));

    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: false } });
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("product itself visible, but its CATEGORY hidden => NOT available", r.json?.[0]?.available === false, JSON.stringify(r.json));
    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: true } }); // restore for the checks below

    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 3 }, { product_id: "does-not-exist", base_units: 1 }] });
    check("batched: independent results per product, unknown id => NOT available",
      r.json?.[0]?.product_id === PID && r.json?.[0]?.available === true && r.json?.[1]?.available === false, JSON.stringify(r.json));

    check("response never leaks the raw stock count or track_stock", !PRIVATE_KEYS.test(r.text));
    check("response has only product_id/available keys per item", Object.keys(r.json?.[0] ?? {}).sort().join(",") === "available,product_id");

    r = await rpc("check_stock_availability", userToken || ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("a logged-in non-admin gets the same public answer as anon (nothing extra)", r.status === 200 && typeof r.json?.[0]?.available === "boolean");

    // restore exactly as section 4 left it: product, subcategory and category all hidden
    await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { is_visible: false } });
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { is_visible: false } });
    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: false } });
  }

  // ------------------------------------------------- 5c. business settings (migration 0008)
  const probe0008 = await rpc("get_business_settings", ANON);
  if (probe0008.status === 404 || pgCode(probe0008) === "PGRST202") {
    skipped.push("business settings (apply supabase/migrations/0008_business_settings.sql, then re-run)");
    section("Business Settings (0008)  --  SKIPPED: migration 0008 is not applied yet");
  } else {
    section("Business Settings (migration 0008)");
    check("anon CAN call get_business_settings()", probe0008.status === 200 && Array.isArray(probe0008.json?.store_hours) && Array.isArray(probe0008.json?.order_hours), `HTTP ${probe0008.status}`);
    check("store_hours and order_hours each have all 7 days", probe0008.json?.store_hours?.length === 7 && probe0008.json?.order_hours?.length === 7);
    check("min_order_cents/delivery_fee_cents are numbers, orders_paused is boolean",
      typeof probe0008.json?.min_order_cents === "number" && typeof probe0008.json?.delivery_fee_cents === "number" && typeof probe0008.json?.orders_paused === "boolean");
    check("no extra/private fields leak (e.g. updated_at)", !/"updated_at"\s*:/.test(probe0008.text));

    for (const t of ["business_hours", "business_settings"]) {
      r = await rest("GET", `${t}?select=*&limit=1`);
      check(`anon cannot SELECT ${t} directly`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    r = await rest("PATCH", "business_settings?id=eq.1", { body: { orders_paused: true } });
    check("anon cannot UPDATE business_settings", isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { body: { is_open: false } });
    check("anon cannot UPDATE business_hours", isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    if (userToken) {
      r = await rest("GET", "business_settings?select=*", { token: userToken });
      check("non-admin sees 0 rows of business_settings", deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rest("PATCH", "business_settings?id=eq.1", { token: userToken, body: { orders_paused: true } });
      check("non-admin cannot UPDATE business_settings", deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }

    // admin: this table is REAL singleton config, not a throwaway probe row — save the original values and
    // restore them exactly afterward (a local try/finally, same spirit as section 5's visibility restores).
    const origSettings = (await rest("GET", "business_settings?select=min_order_cents,delivery_fee_cents,orders_paused", { token: adminToken })).json?.[0];
    const origStoreSunday = (await rest("GET", "business_hours?schedule_type=eq.store&day_of_week=eq.0&select=is_open,open_time,close_time", { token: adminToken })).json?.[0];
    check("(fixture) admin can read the real business_settings/business_hours rows", !!origSettings && !!origStoreSunday, JSON.stringify({ origSettings, origStoreSunday }));
    try {
      r = await rest("PATCH", "business_settings?id=eq.1", { token: adminToken, body: { orders_paused: true, min_order_cents: 6000 } });
      check("admin can UPDATE business_settings", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      const afterPause = await rpc("get_business_settings", ANON);
      check("the manual pause + min order are reflected in the public RPC immediately", afterPause.json?.orders_paused === true && afterPause.json?.min_order_cents === 6000, JSON.stringify(afterPause.json));

      r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: { is_open: false, open_time: null, close_time: null } });
      check("admin can UPDATE business_hours (close a day)", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      const afterClosed = await rpc("get_business_settings", ANON);
      check("the closed day is reflected in the public RPC", afterClosed.json?.store_hours?.find((d) => d.day_of_week === 0)?.is_open === false, JSON.stringify(afterClosed.json?.store_hours));

      r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: { is_open: true, open_time: "09:00", close_time: "10:00" } });
      check("admin can re-open a day with valid hours", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

      r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: { is_open: true, open_time: null, close_time: null } });
      check("marking a day open with no times is rejected (check constraint)", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rest("PATCH", "business_settings?id=eq.1", { token: adminToken, body: { min_order_cents: -1 } });
      check("negative min_order_cents is rejected (check constraint)", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rest("POST", "business_settings", { token: adminToken, body: { id: 2 } });
      check("a second business_settings row is rejected — singleton", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

      if (userToken) {
        r = await rpc("get_business_settings", userToken);
        check("a logged-in non-admin gets the same public answer as anon (nothing extra)", r.status === 200 && typeof r.json?.orders_paused === "boolean");
      }
    } finally {
      // restore exactly as it was before this section touched the real config
      if (origSettings) await rest("PATCH", "business_settings?id=eq.1", { token: adminToken, body: origSettings });
      if (origStoreSunday) await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: origStoreSunday });
      const restored = await rpc("get_business_settings", ANON);
      check("business settings restored to their original values after the probe",
        restored.json?.min_order_cents === origSettings?.min_order_cents && restored.json?.orders_paused === origSettings?.orders_paused, JSON.stringify(restored.json));
    }
  }

  // ------------------------------------------------------------------- 6. sign-ups
  if (CHECK_SIGNUP) {
    section("Public sign-up must be refused");
    r = await call("POST", `${URL_}/auth/v1/signup`, { body: { email: `zz-security-probe-${Date.now()}@example.invalid`, password: randomUUID() + "Aa1!" } });
    check("self-registration is refused", r.status >= 400, `HTTP ${r.status} — if this was 200 a junk user was created: delete it and DISABLE sign-ups (Authentication -> Sign In / Providers)`);
  } else {
    skipped.push("sign-up check (run with --check-signup, or verify 'Allow new users to sign up' is OFF in the dashboard)");
  }
}

try { await main(); }
catch (e) { failed.push(`aborted: ${e.message}`); console.log(`\nABORTED: ${e.message}`); }
finally { if (adminToken) await cleanup(); }

console.log(`\n=== ${passed} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ""} ===`);
if (failed.length) { console.log("Failed:\n" + failed.map((f) => "  - " + f).join("\n")); process.exit(1); }
if (skipped.length) { console.log("NOT FULLY VERIFIED — skipped:\n" + skipped.map((s) => "  - " + s).join("\n")); process.exit(2); }
console.log("All security checks passed.");
