import { test, expect, gotoReady, cartBadge, openCart, rowTexts, drawerTotal, readLocalStorage, buildRpcCatalog, RPC_URL, rpcOk, V2_CART_KEY, LEGACY_CART_KEY } from "../step3/fixtures";
import type { Locator, Page } from "@playwright/test";

/** The card of a product by its (unique) Hebrew name. */
const card = (page: Page, name: string): Locator =>
  page.locator("div.snap-start", { has: page.getByRole("heading", { name, exact: true }) });

test.describe("the customer explicitly chooses unit or package", () => {
  test("10 single units are priced as 10 units (₪510) — never as the package (₪500)", async ({ page }) => {
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    for (let i = 0; i < 10; i++) await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("10"); // addItem confirms availability asynchronously — wait for it to settle
    const drawer = await openCart(page);
    const rows = await rowTexts(drawer);
    expect(rows).toHaveLength(1); // one unit line — no package line appeared
    expect(rows[0]).toContain("10 × יחידה (₪51)");
    expect(rows[0]).not.toContain("פקט");
    expect(await drawerTotal(drawer)).toBe(510);
  });

  test("choosing the package gives the package price and its own line", async ({ page }) => {
    await gotoReady(page);
    await card(page, "מרלבורו אדום").getByRole("button", { name: "פקט", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("1"); // one package = 1 purchase item; addItem confirms availability asynchronously
    const drawer = await openCart(page);
    const rows = await rowTexts(drawer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("פקט (10 יח׳)");
    expect(rows[0]).toContain("1 × פקט (₪510 ₪500)"); // regular struck through, sale shown
    expect(rows[0]).toContain("מבצע -₪10");
    expect(await drawerTotal(drawer)).toBe(500);
  });

  test("2 units + 1 package = 3 purchase items, as two independent lines", async ({ page }) => {
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await c.getByRole("button", { name: "פקט", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("3"); // addItem confirms availability asynchronously — wait for it to settle
    await expect(page.getByText("3 פריטים בסל")).toBeVisible(); // bottom bar uses the same count
    const drawer = await openCart(page);
    const rows = await rowTexts(drawer);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("2 × יחידה (₪51)");
    expect(rows[1]).toContain("1 × פקט");
    expect(await drawerTotal(drawer)).toBe(602); // 2 x 51 + 500
  });

  test("each line's stepper and remove button affect only that line", async ({ page }) => {
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await c.getByRole("button", { name: "פקט", exact: true }).click();
    const drawer = await openCart(page);

    await drawer.getByRole("button", { name: "הוסף פקט" }).click();
    await expect.poll(() => cartBadge(page)).toBe("3"); // 1 unit + 2 packages; addItem confirms availability asynchronously
    const rows = await rowTexts(drawer);
    expect(rows[0]).toContain("1 × יחידה");
    expect(rows[1]).toContain("2 × פקט");
    expect(await drawerTotal(drawer)).toBe(1051); // 51 + 2 x 500

    await drawer.getByRole("button", { name: "הפחת יחידה" }).click(); // unit 1 -> 0 removes only the unit line
    const after = await rowTexts(drawer);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("2 × פקט");

    await drawer.getByRole("button", { name: /^הסר .*פקט/ }).click(); // remove the package line
    await expect(drawer).toContainText("הסל שלך ריק כרגע");
    expect(await cartBadge(page)).toBe("");
  });

  test("the cart persists as explicit lines under balagan_cart_v2, and never writes the old key", async ({ page }) => {
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await c.getByRole("button", { name: "פקט", exact: true }).click();
    // addItem confirms availability asynchronously before writing to storage — wait for it to settle
    await expect.poll(() => cartBadge(page)).toBe("3");
    expect(JSON.parse((await readLocalStorage(page, V2_CART_KEY))!)).toEqual([
      { productId: "1", option: "unit", quantity: 2 },
      { productId: "1", option: "package", quantity: 1 },
    ]);
    expect(await readLocalStorage(page, LEGACY_CART_KEY)).toBeNull();
    await page.reload();
    await page.locator("div.snap-start").first().waitFor();
    expect(await cartBadge(page)).toBe("3");
  });
});

test.describe("money arithmetic has no floating-point noise", () => {
  test.use({ savedCartV2: JSON.stringify([{ productId: "31", option: "unit", quantity: 9 }]) }); // ווינסטון קומפקט קוד, ₪44.9

  test("9 x ₪44.9 is ₪404.1 (it used to show 404.09999999999997)", async ({ page }) => {
    await gotoReady(page);
    const bar = await page.locator(".fixed.bottom-0").innerText(); // bottom cart bar total
    expect(bar).toContain("₪404.1");
    const drawer = await openCart(page);
    const rows = await rowTexts(drawer);
    expect(rows[0]).toContain("9 × יחידה (₪44.9)");
    expect(rows[0]).toContain("₪404.1");
    expect(await drawerTotal(drawer)).toBe(404.1);
    expect((await drawer.innerText()).match(/\d\.\d{3,}/)).toBeNull();
  });
});

test.describe("unavailable lines", () => {
  test.use({ savedCartV2: JSON.stringify([{ productId: "3", option: "unit", quantity: 2 }, { productId: "1", option: "unit", quantity: 1 }]) });

  test("an out-of-stock line is shown as אזל, cannot be increased, and is excluded from count and total", async ({ page }) => {
    await gotoReady(page); // product 3 (מרלבורו טאץ׳) is out of stock
    expect(await cartBadge(page)).toBe("1");
    const drawer = await openCart(page);
    const rows = await rowTexts(drawer);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("אזל — לא נכלל בסכום");
    expect(await drawerTotal(drawer)).toBe(51);
    await expect(drawer.locator("li").first().getByRole("button", { name: "הוסף יחידה" })).toBeDisabled();
    // it can still be removed
    await drawer.locator("li").first().getByRole("button", { name: /^הסר/ }).click();
    expect(await rowTexts(drawer)).toHaveLength(1);
  });
});

// ---- data-driven card rendering: needs control over the catalog, so only the stubbed-database variant ----
test.describe("per-option sales, labels and availability (custom catalog data)", () => {
  test.beforeEach(({ mode }) => {
    test.skip(mode !== "supabase", "needs a controllable catalog (stubbed database variant)");
  });

  const mutate = (changes: Record<string, (p: Record<string, unknown>) => Record<string, unknown>>) =>
    buildRpcCatalog((products) => products.map((p) => (changes[p.id as string] ? changes[p.id as string](p) : p)));

  test("unit sale + custom package label without a package sale", async ({ page }) => {
    await page.route(RPC_URL, rpcOk(mutate({
      "1": (p) => ({
        ...p,
        unit: { price: 51, sale_price: 45, in_stock: true },
        package: { label: "מארז", unit_count: 24, price: 1000, sale_price: null, in_stock: true },
      }),
    })));
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");

    // unit: regular struck through in red, sale in gold
    await expect(c.locator(".line-through")).toHaveCount(1);
    await expect(c.locator(".line-through")).toHaveText("₪51");
    await expect(c.locator(".text-brand-gold", { hasText: "₪45" })).toBeVisible();
    // package: custom label + count, ONE plain price, no strikethrough
    await expect(c.getByText("מארז (24)")).toBeVisible();
    await expect(c).toContainText("₪1000");
    await expect(c.getByRole("button", { name: "מארז", exact: true })).toBeEnabled();

    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await c.getByRole("button", { name: "מארז", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("2"); // addItem confirms availability asynchronously — wait for it to settle
    const drawer = await openCart(page);
    const rows = await rowTexts(drawer);
    expect(rows[0]).toContain("1 × יחידה (₪51 ₪45)");
    expect(rows[0]).toContain("מבצע -₪6");
    expect(rows[1]).toContain("מארז (24 יח׳)");
    expect(rows[1]).toContain("1 × מארז (₪1000)");
    expect(rows[1]).not.toContain("מבצע");
    expect(await drawerTotal(drawer)).toBe(1045); // 45 + 1000
  });

  test("a product without a package shows only the unit row and a single button", async ({ page }) => {
    await page.route(RPC_URL, rpcOk(mutate({ "2": (p) => ({ ...p, package: null }) })));
    await gotoReady(page);
    const c = card(page, "מרלבורו גולד");
    await expect(c.getByRole("button")).toHaveCount(1);
    await expect(c.getByRole("button", { name: "יחידה", exact: true })).toBeEnabled();
    await expect(c).not.toContainText("פקט");
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("1"); // addItem confirms availability asynchronously — wait for it to settle
  });

  test("availability is per option; the אזל badge appears only when neither can be bought", async ({ page }) => {
    await page.route(RPC_URL, rpcOk(mutate({
      "4": (p) => ({ ...p, package: { ...(p.package as object), in_stock: false } }), // package out, unit in
      "5": (p) => ({ ...p, unit: { ...(p.unit as object), in_stock: false } }), // unit out, package in
    })));
    await gotoReady(page);
    const packageOut = card(page, "ווינסטון כחול");
    await expect(packageOut.getByRole("button", { name: "יחידה", exact: true })).toBeEnabled();
    await expect(packageOut.getByRole("button", { name: "פקט", exact: true })).toBeDisabled();
    await expect(packageOut.getByText("אזל")).toHaveCount(0);

    const unitOut = card(page, "ווינסטון אדום");
    await expect(unitOut.getByRole("button", { name: "יחידה", exact: true })).toBeDisabled();
    await expect(unitOut.getByRole("button", { name: "פקט", exact: true })).toBeEnabled();
    await expect(unitOut.getByText("אזל")).toHaveCount(0);

    // a product out of stock on both options still shows the badge (id 3, from the seeded data)
    const both = card(page, "מרלבורו טאץ׳");
    await expect(both.getByText("אזל")).toBeVisible();
    await expect(both.getByRole("button", { name: "יחידה", exact: true })).toBeDisabled();
    await expect(both.getByRole("button", { name: "פקט", exact: true })).toBeDisabled();
  });

  test.describe("a saved package line whose package was removed", () => {
    test.use({ savedCartV2: JSON.stringify([{ productId: "5", option: "package", quantity: 1 }, { productId: "1", option: "unit", quantity: 1 }]) });

    test("is not shown or priced, but stays in storage", async ({ page }) => {
      await page.route(RPC_URL, rpcOk(mutate({ "5": (p) => ({ ...p, package: null }) })));
      await gotoReady(page);
      expect(await cartBadge(page)).toBe("1");
      const drawer = await openCart(page);
      expect(await rowTexts(drawer)).toHaveLength(1);
      expect(JSON.parse((await readLocalStorage(page, V2_CART_KEY))!)).toContainEqual({ productId: "5", option: "package", quantity: 1 });
    });
  });

  test("the sale price shows in search results", async ({ page }) => {
    await page.route(RPC_URL, rpcOk(mutate({ "1": (p) => ({ ...p, unit: { price: 51, sale_price: 45, in_stock: true } }) })));
    await gotoReady(page);
    await page.getByRole("button", { name: "חיפוש", exact: true }).click();
    await page.getByPlaceholder(/חיפוש מוצרים/).fill("מרלבורו אדום");
    // the first result row: the one that has an add-to-cart button and the product's name
    const first = page.locator("div.rounded-lg", { has: page.getByRole("button", { name: "הוסף לסל" }), hasText: "מרלבורו אדום" }).first();
    await expect(first.locator(".line-through")).toHaveText("₪51");
    await expect(first).toContainText("₪45");
  });
});
