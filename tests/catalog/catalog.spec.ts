import { test, expect, gotoReady, cartBadge, cartFixtures, buildRpcCatalog, baseline, rpcOk, rpcStatus, rpcRaw, RPC_URL } from "./fixtures";

const multiCart = cartFixtures.find((f) => f.name === "multi-product")!.storageValue; // legacy payload: 12 + 3 + 1(out of stock) + 10 units
/** What that legacy cart migrates to (the v2 cart): units stay units. */
const multiCartV2 = JSON.stringify([
  { productId: "1", option: "unit", quantity: 12 },
  { productId: "2", option: "unit", quantity: 3 },
  { productId: "3", option: "unit", quantity: 1 },
  { productId: "58", option: "unit", quantity: 10 },
]);
const LEGACY_KEY = "balagan_cart";
const V2_KEY = "balagan_cart_v2";
const PURCHASABLE_ITEMS = "25"; // 12 + 3 + 10 — product 3 is out of stock, so it is shown as "אזל" and not counted
const cardsLocator = "div.snap-start";
const cacheJson = (catalog: unknown) => JSON.stringify({ v: 1, savedAt: 0, data: catalog });
const readLs = (page: import("@playwright/test").Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test.describe("catalog loading — database source", () => {
  test.beforeEach(({ mode }) => {
    test.skip(mode !== "supabase", "only the database-backed variant loads a live catalog");
  });

  test.describe("first-ever visit with a saved cart", () => {
    test.use({ savedCart: multiCart });

    test("shows a loading state, never touches the saved cart, then renders and caches the live catalog", async ({ page }) => {
      await page.route(RPC_URL, rpcOk(buildRpcCatalog(), 1500));
      await page.goto("/");

      await expect(page.getByRole("status").filter({ hasText: "טוען מוצרים" })).toBeVisible();
      await expect(page.locator(cardsLocator)).toHaveCount(0);
      expect(await cartBadge(page)).toBe(""); // lines can't be priced until the catalog exists…
      expect(await readLs(page, V2_KEY)).toBe(multiCartV2); // …but nothing is erased: the whole cart is kept
      expect(await readLs(page, LEGACY_KEY)).toBe(multiCart); // and the old key is never touched

      await expect(page.locator(cardsLocator).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("status").filter({ hasText: "טוען מוצרים" })).toHaveCount(0);
      expect(await cartBadge(page)).toBe(PURCHASABLE_ITEMS); // the SAME saved cart now prices correctly
      expect(await readLs(page, V2_KEY)).toBe(multiCartV2);
      expect(await readLs(page, LEGACY_KEY)).toBe(multiCart);

      const cached = JSON.parse((await readLs(page, "balagan_catalog_v1"))!);
      expect(cached.data.products).toHaveLength(baseline.totals.products);
    });
  });

  test.describe("live catalog unavailable, nothing cached, saved cart", () => {
    test.use({ savedCart: multiCart });

    for (const [name, handler] of [
      ["HTTP 500", rpcStatus(500)],
      ["malformed JSON shape", rpcRaw(JSON.stringify({ categories: [], products: [{ id: 5 }] }))],
      ["not JSON at all", rpcRaw("<html>gateway error</html>")],
    ] as const) {
      test(`falls back to the bundled catalog (${name}); cart intact`, async ({ page }) => {
        await page.route(RPC_URL, handler);
        await gotoReady(page);
        await expect(page.locator(cardsLocator)).toHaveCount(110);
        expect(await cartBadge(page)).toBe(PURCHASABLE_ITEMS);
        expect(await readLs(page, V2_KEY)).toBe(multiCartV2);
        expect(await readLs(page, LEGACY_KEY)).toBe(multiCart);
        expect(await readLs(page, "balagan_catalog_v1")).toBeNull(); // a failed fetch never poisons the cache
      });
    }

    test("request that never answers times out into the fallback", async ({ page }) => {
      test.setTimeout(30_000);
      await page.route(RPC_URL, () => { /* never fulfil */ });
      await page.goto("/");
      await expect(page.locator(cardsLocator).first()).toBeVisible({ timeout: 15_000 }); // 8s client timeout
      expect(await readLs(page, V2_KEY)).toBe(multiCartV2);
      expect(await readLs(page, LEGACY_KEY)).toBe(multiCart);
    });
  });

  test.describe("returning visit with a cached catalog", () => {
    test.use({ catalogCache: cacheJson(buildRpcCatalog()), savedCart: JSON.stringify([{ productId: "1", quantity: 1 }]) });

    test("renders instantly from cache, then live changes replace it (and the cache)", async ({ page }) => {
      const live = buildRpcCatalog((products) => products.map((p) => (p.id === "1" ? { ...p, unit: { ...(p.unit as object), price: 55 } } : p)));
      await page.route(RPC_URL, rpcOk(live, 2000));
      await page.goto("/");

      // instant: cards present, no loading state, still the cached price
      await expect(page.locator(cardsLocator).first()).toBeVisible({ timeout: 1500 });
      await expect(page.getByRole("status").filter({ hasText: "טוען מוצרים" })).toHaveCount(0);
      const first = page.locator(cardsLocator).first();
      await expect(first).toContainText("₪51");
      expect(await cartBadge(page)).toBe("1");

      // after the background refresh: the DB change is on screen and in the cache
      await expect(first).toContainText("₪55", { timeout: 10_000 });
      // the package has its OWN stored price and sale — changing the unit price does not move it
      await expect(first).toContainText("₪510");
      await expect(first).toContainText("₪500");
      const cached = JSON.parse((await readLs(page, "balagan_catalog_v1"))!);
      expect(cached.data.products.find((p: { id: string }) => p.id === "1").unit.price).toBe(55);
    });

    test("live fetch fails => keeps showing the cache", async ({ page }) => {
      await page.route(RPC_URL, rpcStatus(503));
      await gotoReady(page);
      await page.waitForTimeout(500);
      await expect(page.locator(cardsLocator)).toHaveCount(110);
      await expect(page.locator(cardsLocator).first()).toContainText("₪51");
    });
  });

  test.describe("a corrupted cache is ignored", () => {
    test.use({ catalogCache: "{not json" });
    test("behaves like a first visit", async ({ page }) => {
      await gotoReady(page);
      await expect(page.locator(cardsLocator)).toHaveCount(110);
    });
  });

  test.describe("product hidden/removed in the database while it is in a saved cart", () => {
    const cart = JSON.stringify([{ productId: "2", quantity: 3 }, { productId: "1", quantity: 1 }]);
    const cartV2 = JSON.stringify([{ productId: "2", option: "unit", quantity: 3 }, { productId: "1", option: "unit", quantity: 1 }]);
    test.use({ savedCart: cart });

    test("its line disappears from the visible cart but is NOT erased from storage; it returns with the product", async ({ page }) => {
      await page.route(RPC_URL, rpcOk(buildRpcCatalog((ps) => ps.filter((p) => p.id !== "2"))));
      await gotoReady(page);
      expect(await cartBadge(page)).toBe("1"); // only product 1 is priced
      expect(await readLs(page, V2_KEY)).toBe(cartV2); // product 2's line survives

      await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
      await page.reload();
      await page.locator(cardsLocator).first().waitFor();
      expect(await cartBadge(page)).toBe("4");
    });
  });
});

test.describe("static source", () => {
  test("makes no database request and writes no catalog cache", async ({ page, mode }) => {
    test.skip(mode !== "static", "static variant only");
    const hits: string[] = [];
    page.on("request", (r) => { if (/supabase/.test(r.url())) hits.push(r.url()); });
    await gotoReady(page);
    await expect(page.locator(cardsLocator)).toHaveCount(110);
    expect(hits).toEqual([]);
    expect(await readLs(page, "balagan_catalog_v1")).toBeNull();
  });
});
