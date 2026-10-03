import { test as base, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { expect };

// package.json has "type": "module", so there is no __dirname
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8")) as T;

// ------------------------------------------------------------------ baseline data
export interface BaselineProduct {
  position: number; id: string; name: string; brand: string; category: string; subcategory: string;
  unitPrice: number; oldPackRegular: number; oldPackPrice: number; inStock: boolean; image: string; description: string | null;
}
export interface BaselineCatalog {
  totals: { products: number; categories: number; subcategories: number };
  categories: { id: string; slug: string; name: string; productCount: number;
    subcategories: { id: string; slug: string; name: string; anchorId: string; productCount: number; productIds: string[] }[] }[];
  products: BaselineProduct[];
}
export const baseline = readJson<BaselineCatalog>("tests/baseline/catalog.json");
export const cartFixtures = readJson<{ fixtures: { name: string; storageKey: string; storageValue: string }[] }>("tests/baseline/cart-legacy-fixtures.json").fixtures;
export const cartObserved = readJson<{ results: { name: string; storageAfterLoad: string; headerCartButtonText: string; drawerTotal: number | null; drawerLines: string[] }[] }>("tests/baseline/cart-legacy-observed.json").results;
export const domText = (viewport: string, category: string): string =>
  readFileSync(resolve(ROOT, `tests/baseline/dom-text/${viewport}-${category}.txt`), "utf8");

// ------------------------------------------- what get_storefront_catalog() returns
/**
 * The RPC payload the live database returns for the seeded catalog. Built from the
 * frozen baseline with the exact seed rules (package 'פקט' x10, regular = old
 * struck-through pack price, active sale = old pack price). scripts/verify-seed.mjs
 * proves the real database equals the baseline, so this is a faithful stand-in.
 */
export function buildRpcCatalog(mutate?: (products: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const byId = new Map(baseline.products.map((p) => [p.id, p]));
  const categories = baseline.categories.map((c) => ({
    id: c.id, slug: c.slug, name_he: c.name, name_en: null,
    subcategories: c.subcategories.map((s) => ({ id: s.id, slug: s.slug, name_he: s.name, name_en: null })),
  }));
  let products: Record<string, unknown>[] = baseline.categories.flatMap((c) => c.subcategories.flatMap((s) => s.productIds)).map((id) => {
    const p = byId.get(id)!;
    return {
      id: p.id, category: p.category, subcategory: p.subcategory, name_he: p.name, name_en: null, brand: p.brand,
      description: p.description, image_path: null,
      unit: { price: p.unitPrice, sale_price: null, in_stock: p.inStock },
      package: { label: "פקט", unit_count: 10, price: p.oldPackRegular, sale_price: p.oldPackPrice, in_stock: p.inStock },
    };
  });
  if (mutate) products = mutate(products);
  return { categories, products };
}

// ------------------------------------------------------------------ route helpers
export const RPC_URL = "**/rest/v1/rpc/get_storefront_catalog";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const preflight = (route: Route) => route.fulfill({ status: 204, headers: CORS });

export const rpcOk = (catalog: unknown = buildRpcCatalog(), delayMs = 0) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return preflight(route);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(catalog) });
};
/**
 * check_stock_availability() (supabase/migrations/0007_stock_availability.sql) — the cart's shared-stock
 * quantity check. `unavailable` names product ids that should come back `available: false`; every other
 * requested product defaults to available (matches reality: no baseline/seeded product tracks stock).
 */
export const STOCK_RPC_URL = "**/rest/v1/rpc/check_stock_availability";
export const stockOk = (unavailable: readonly string[] = [], delayMs = 0) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return preflight(route);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const body = JSON.parse(route.request().postData() ?? "{}") as { p_items?: { product_id: string; base_units: number }[] };
  const result = (body.p_items ?? []).map((item) => ({ product_id: item.product_id, available: !unavailable.includes(item.product_id) }));
  await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(result) });
};
/** Same RPC, but with an actual numeric cap per product (base units) — mirrors `NOT track_stock OR stock_base_units >= base_units`. A product not listed has no limit. */
export const stockLimited = (limits: Record<string, number>, delayMs = 0) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return preflight(route);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const body = JSON.parse(route.request().postData() ?? "{}") as { p_items?: { product_id: string; base_units: number }[] };
  const result = (body.p_items ?? []).map((item) => ({
    product_id: item.product_id,
    available: !(item.product_id in limits) || item.base_units <= limits[item.product_id],
  }));
  await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(result) });
};

export const rpcStatus = (status: number, delayMs = 0) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return preflight(route);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  await route.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify({ message: "boom" }) });
};
export const rpcRaw = (body: string) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return preflight(route);
  await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body });
};

// ------------------------------------------------------------------------ fixtures
type Opts = {
  /** false => the 21+ age gate is shown. */
  ageVerified: boolean;
  /** raw localStorage["balagan_cart"] (the LEGACY cart format) to pre-load, or null */
  savedCart: string | null;
  /** raw localStorage["balagan_cart_v2"] (the current cart format) to pre-load, or null */
  savedCartV2: string | null;
  /** raw localStorage["balagan_catalog_v1"] to pre-load, or null */
  catalogCache: string | null;
};

export const test = base.extend<Opts & { mode: string; vp: string }>({
  ageVerified: [true, { option: true }],
  savedCart: [null, { option: true }],
  savedCartV2: [null, { option: true }],
  catalogCache: [null, { option: true }],
  mode: async ({}, use, testInfo) => use(String(testInfo.project.metadata.mode)),
  vp: async ({}, use, testInfo) => use(String(testInfo.project.metadata.viewport)),

  page: async ({ page, ageVerified, savedCart, savedCartV2, catalogCache, mode }, use) => {
    // deterministic: fixed clock (business-hours bar), no external web fonts, no animations
    await page.clock.setFixedTime(new Date("2026-09-20T10:00:00+03:00"));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.addInitScript(
      ([age, cart, cartV2, cache]) => {
        try {
          if (age) localStorage.setItem("balagan_age_verified", "true");
          if (cart !== null) localStorage.setItem("balagan_cart", cart);
          if (cartV2 !== null) localStorage.setItem("balagan_cart_v2", cartV2);
          if (cache !== null) localStorage.setItem("balagan_catalog_v1", cache);
        } catch { /* ignore */ }
      },
      [ageVerified, savedCart, savedCartV2, catalogCache] as const
    );
    // the "supabase" variant talks to a fake host: answer its RPC with the seeded catalog (tests may override)
    if (mode === "supabase" || mode === "account") {
      await page.route(RPC_URL, rpcOk());
      await page.route(STOCK_RPC_URL, stockOk());
    }
    await use(page);
  },
});

// ------------------------------------------------------------------------ page helpers
/**
 * Makes a screenshot deterministic: animations/transitions off, fonts settled, and EVERY image
 * (the hero/logo PNGs are >1 MB) loaded and decoded. Without the image wait, a screenshot can
 * catch a large image half-painted, which shows up as a faint whole-frame diff.
 */
export async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    // lazy images that were never scrolled into view never load — don't wait for those
    const eager = [...document.images].filter((img) => !(img.loading === "lazy" && !img.complete));
    const loaded = Promise.all(
      eager.map((img) =>
        img.complete
          ? img.decode().catch(() => undefined)
          : new Promise<void>((resolve) => {
              img.addEventListener("load", () => resolve(), { once: true });
              img.addEventListener("error", () => resolve(), { once: true });
            })
      )
    );
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  });
  await page.waitForTimeout(300);
}

export async function gotoReady(page: Page, hash = ""): Promise<void> {
  await page.goto("/" + hash);
  await page.locator("div.snap-start").first().waitFor({ state: "attached" });
  await settle(page);
}

export const cartBadge = (page: Page) =>
  page.evaluate(() => (document.querySelector('header button[aria-label="פתיחת סל הקניות"]') as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? "");

/** Same extraction used to capture tests/baseline/dom-text/*.txt at Step 0. */
export const extractDomText = (page: Page) =>
  page.evaluate(() => {
    const n = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
    const out: string[] = [];
    out.push("# viewport " + window.innerWidth + "x" + window.innerHeight);
    out.push("# info-bar: " + n((document.querySelector(".sticky.top-0.z-30") as HTMLElement | null)?.innerText));
    const nav = document.querySelector("#categories")!;
    out.push("# category-tabs: " + [...nav.querySelectorAll('[role="region"] > *')].map((e) => n((e as HTMLElement).innerText)).join(" || "));
    out.push("# subcategory-nav: " + [...nav.querySelectorAll("button, a")].map((e) => n((e as HTMLElement).innerText)).filter(Boolean).join(" | "));
    const section = document.querySelector("main section[id]")!;
    out.push("# section: #" + section.id + " h2=" + n((section.querySelector("h2") as HTMLElement | null)?.innerText));
    section.querySelectorAll(":scope > div > div[id]").forEach((sub) => {
      out.push("");
      out.push("## #" + sub.id + " :: " + n((sub.querySelector("h3.text-sm") as HTMLElement | null)?.innerText));
      sub.querySelectorAll("div.snap-start").forEach((card, i) => {
        const parts = (card as HTMLElement).innerText.split("\n").map(n).filter(Boolean);
        const buttons = [...card.querySelectorAll("button")].map((b) => n((b as HTMLElement).innerText) + ((b as HTMLButtonElement).disabled ? "(disabled)" : ""));
        out.push((i + 1) + ". " + parts.filter((p) => !buttons.some((b) => b.startsWith(p))).join(" | ") + "  ⟦buttons: " + buttons.join(", ") + "⟧");
      });
    });
    out.push("");
    out.push("# total cards: " + section.querySelectorAll("div.snap-start").length);
    return out.join("\n");
  });

// ------------------------------------------------------------------------ cart helpers
export const DRAWER = '[role="dialog"][aria-label="סל הקניות"]';
export const LEGACY_CART_KEY = "balagan_cart";
export const V2_CART_KEY = "balagan_cart_v2";

/** Opens the cart drawer and returns its locator. */
export async function openCart(page: Page) {
  await page.getByRole("button", { name: "פתיחת סל הקניות" }).first().click();
  await page.waitForTimeout(500);
  return page.locator(DRAWER);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Normalised text of one drawer row. */
export const rowTexts = async (drawer: import("@playwright/test").Locator) =>
  (await drawer.locator("li").allInnerTexts()).map(squash);

/** The ₪ items subtotal shown in the drawer footer — what the legacy-parity specs always meant by "the total" (null when the cart is empty). */
export async function drawerTotal(drawer: import("@playwright/test").Locator): Promise<number | null> {
  const match = /סכום ביניים ₪([0-9.]+)/.exec(squash(await drawer.innerText()));
  return match ? Number(match[1]) : null;
}

/** The amount actually due shown in the drawer footer: items + delivery (null when the cart is empty). */
export async function drawerPayable(drawer: import("@playwright/test").Locator): Promise<number | null> {
  const match = /סה"כ לתשלום ₪([0-9.]+)/.exec(squash(await drawer.innerText()));
  return match ? Number(match[1]) : null;
}

export const readLocalStorage = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
