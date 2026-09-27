import { test, expect, gotoReady, cartBadge, openCart, rowTexts, RPC_URL, rpcOk, rpcStatus, STOCK_RPC_URL, stockOk, stockLimited, buildRpcCatalog } from "../../catalog/fixtures";
import type { Locator, Page } from "@playwright/test";

/**
 * The cart's shared-stock quantity check, added after Step 7 (supabase/migrations/0007_stock_availability.sql):
 * `addItem`/`increment` confirm the product's TOTAL requested quantity (unit + package lines, converted to
 * base units) still fits the shared stock BEFORE changing the cart, and refuse the change — with a Hebrew
 * message, cart left exactly as it was — if it doesn't fit or if the check itself couldn't be completed
 * (fail CLOSED). Every add-to-cart entry point funnels through the same `addItem`, so the deep behavioural
 * coverage lives here, once; each entry point gets a light confirmation that it isn't bypassed.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "the shared-stock check only exists against the database-backed variant");
});

const card = (page: Page, name: string): Locator =>
  page.locator("div.snap-start", { has: page.getByRole("heading", { name, exact: true }) });
const limitToast = (page: Page) => page.getByRole("status").filter({ hasText: "המלאי הזמין אינו מספיק" });
const retryToast = (page: Page) => page.getByRole("status").filter({ hasText: "לא ניתן לבדוק את זמינות המלאי" });

test.describe("adding more than the available stock is refused", () => {
  test("stock of 1: the first unit is added, a second is refused with a clear message, cart stays at 1", async ({ page }) => {
    await page.route(STOCK_RPC_URL, stockLimited({ "1": 1 }));
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");

    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("1");

    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await expect(limitToast(page)).toBeVisible();
    await expect.poll(() => cartBadge(page)).toBe("1"); // unchanged — the refused add never touched the cart
    const drawer = await openCart(page);
    expect(await rowTexts(drawer)).toHaveLength(1);
  });

  test("mixed unit + package quantities share the SAME stock (stock of 12, package of 10)", async ({ page }) => {
    await page.route(STOCK_RPC_URL, stockLimited({ "1": 12 }));
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");

    await c.getByRole("button", { name: "פקט", exact: true }).click(); // 1 package = 10 base units
    await expect.poll(() => cartBadge(page)).toBe("1");
    await c.getByRole("button", { name: "יחידה", exact: true }).click(); // +1 unit = 11
    await c.getByRole("button", { name: "יחידה", exact: true }).click(); // +1 unit = 12 — exactly the limit
    await expect.poll(() => cartBadge(page)).toBe("3"); // 1 package + 2 units = 3 purchase items

    await c.getByRole("button", { name: "יחידה", exact: true }).click(); // +1 more = 13 — over the limit
    await expect(limitToast(page)).toBeVisible();
    await expect.poll(() => cartBadge(page)).toBe("3"); // unchanged
  });

  test("increasing quantity from the cart drawer's own + button is checked the same way", async ({ page }) => {
    await page.route(STOCK_RPC_URL, stockLimited({ "1": 2 }));
    await gotoReady(page);
    await card(page, "מרלבורו אדום").getByRole("button", { name: "יחידה", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("1");
    const drawer = await openCart(page);

    await drawer.getByRole("button", { name: "הוסף יחידה" }).click(); // 1 -> 2, exactly the limit
    await expect.poll(() => cartBadge(page)).toBe("2");

    await drawer.getByRole("button", { name: "הוסף יחידה" }).click(); // 2 -> 3, over the limit
    await expect(limitToast(page)).toBeVisible();
    await expect.poll(() => cartBadge(page)).toBe("2"); // unchanged
    expect((await rowTexts(drawer))[0]).toContain("2 × יחידה");
  });

  test("stock tracking disabled (the default): no numeric limit at all", async ({ page }) => {
    await page.route(STOCK_RPC_URL, stockOk()); // no product listed => always available, same as an untracked product
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    for (let i = 0; i < 15; i++) await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("15");
  });

  test("a manually-disabled option is unaffected — still blocked by the existing availability switch, the stock check is never even reached", async ({ page }) => {
    const calls: string[] = [];
    await page.route(STOCK_RPC_URL, async (route) => {
      calls.push(route.request().postData() ?? "");
      await stockOk()(route);
    });
    await page.route(RPC_URL, rpcOk(buildRpcCatalog((products) => products.map((p) => (p.id === "1" ? { ...p, package: { ...(p.package as object), in_stock: false } } : p)))));
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    await expect(c.getByRole("button", { name: "פקט", exact: true })).toBeDisabled(); // a disabled button can't be clicked at all
    await expect.poll(() => cartBadge(page)).toBe("");
    expect(calls).toHaveLength(0); // the quantity check was never even called for a refused option
  });

  test("a failed/unreachable stock check refuses the add too (fails CLOSED) with its own message", async ({ page }) => {
    await page.route(STOCK_RPC_URL, rpcStatus(500));
    await gotoReady(page);
    await card(page, "מרלבורו אדום").getByRole("button", { name: "יחידה", exact: true }).click();
    await expect(retryToast(page)).toBeVisible();
    await expect.poll(() => cartBadge(page)).toBe(""); // never added on an unverified check
  });
});

test.describe("stock dropping after items are already in the cart", () => {
  test("opening the drawer re-checks the cart; a now-over-limit line is flagged and adjustable, others untouched", async ({ page }) => {
    let limit = 5;
    await page.route(STOCK_RPC_URL, async (route) => stockLimited({ "1": limit })(route));
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await expect.poll(() => cartBadge(page)).toBe("2");

    limit = 1; // the admin lowered stock while the customer already had 2 in the cart
    const drawer = await openCart(page);
    await expect(drawer.getByText("הכמות שבסל אינה זמינה יותר במלאי")).toBeVisible({ timeout: 10_000 });
    await expect(drawer.getByRole("button", { name: "הוסף יחידה" })).toBeDisabled();

    // the customer can still adjust it down themselves
    await drawer.getByRole("button", { name: "הפחת יחידה" }).click(); // 2 -> 1, now within the (lowered) limit
    await expect(drawer.getByText("הכמות שבסל אינה זמינה יותר במלאי")).toHaveCount(0, { timeout: 10_000 });
    await expect(drawer.getByRole("button", { name: "הוסף יחידה" })).toBeEnabled();
  });
});

test.describe("every storefront add-to-cart entry point is checked identically", () => {
  test.use({ savedCartV2: JSON.stringify([]) });

  test("ProductCard's unit and package buttons", async ({ page }) => {
    await page.route(STOCK_RPC_URL, stockLimited({ "1": 0 }));
    await gotoReady(page);
    const c = card(page, "מרלבורו אדום");
    await c.getByRole("button", { name: "יחידה", exact: true }).click();
    await expect(limitToast(page)).toBeVisible();
    await c.getByRole("button", { name: "פקט", exact: true }).click();
    await expect(limitToast(page)).toBeVisible();
    await expect.poll(() => cartBadge(page)).toBe("");
  });

  test("Search's add-to-cart button", async ({ page }) => {
    await page.route(STOCK_RPC_URL, stockLimited({ "1": 0 }));
    await gotoReady(page);
    await page.getByRole("button", { name: "חיפוש", exact: true }).click();
    await page.getByPlaceholder(/חיפוש מוצרים/).fill("מרלבורו אדום");
    await page.getByRole("button", { name: "הוסף לסל" }).first().click();
    await expect(limitToast(page)).toBeVisible();
    await expect.poll(() => cartBadge(page)).toBe("");
  });
});
